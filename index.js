const mineflayer = require('mineflayer');
const { pathfinder, Movements, goals: { GoalBlock, GoalNear } } = require('mineflayer-pathfinder');
const fs = require('fs');
const Vec3 = require('vec3');
const config = require('./config.json');

const bot = mineflayer.createBot({
  host: config.host,
  port: config.port,
  username: config.username,
  version: config.version || false,
});

bot.loadPlugin(pathfinder);

// Logging utility
function log(msg) {
  const time = new Date().toISOString();
  const message = `[${time}] ${msg}`;
  console.log(message);
  fs.appendFileSync('logs.txt', message + '\n');
}

// Catch client errors
bot._client.on('error', err => {
  log(`[Client Error] ${err.message}`);
});
bot._client.on('close', () => {
  log(`[Client] Connection closed.`);
});

// Auto register/login
bot.on('message', (jsonMsg) => {
  const message = jsonMsg.toString().toLowerCase();
  const password = config.loginCode;

  if (message.includes('register') || message.includes('not registered')) {
    bot.chat(`/register ${password} ${password}`);
    log(`[Login] Registered.`);
  } else if (message.includes('login') || message.includes('logged out')) {
    bot.chat(`/login ${password}`);
    log(`[Login] Logged in.`);
  }
});

bot.once('spawn', () => {
  const mcData = require('minecraft-data')(bot.version);
  const defaultMove = new Movements(bot, mcData);
  bot.pathfinder.setMovements(defaultMove);

  const houseCenter = new Vec3(-1244, 72, -448);
  const houseSize = 11;

  // Async scan for walkable points with yielding to avoid blocking event loop
  async function getRandomWalkablePoint() {
    const half = Math.floor(houseSize / 2);
    const candidates = [];

    for (let x = houseCenter.x - half; x <= houseCenter.x + half; x++) {
      for (let z = houseCenter.z - half; z <= houseCenter.z + half; z++) {
        for (let y = houseCenter.y - 1; y <= houseCenter.y + 5; y++) {
          // Yield control every 100 candidates to prevent blocking
          if (candidates.length > 0 && candidates.length % 100 === 0) await new Promise(r => setTimeout(r, 0));

          const pos = new Vec3(x, y, z);
          const blockBelow = bot.blockAt(pos.offset(0, -1, 0));
          const blockAt = bot.blockAt(pos);
          const blockAbove = bot.blockAt(pos.offset(0, 1, 0));

          if (
            blockBelow && blockBelow.boundingBox === 'block' &&
            blockAt && blockAt.boundingBox === 'empty' &&
            blockAbove && blockAbove.boundingBox === 'empty'
          ) {
            candidates.push(pos);
          }
        }
      }
    }

    if (candidates.length === 0) return houseCenter;
    return candidates[Math.floor(Math.random() * candidates.length)];
  }

  async function roamInsideHouse() {
    const target = await getRandomWalkablePoint();
    const goal = new GoalBlock(target.x, target.y, target.z);
    bot.pathfinder.setGoal(goal);
    log(`[Move] Roaming to (${goal.x}, ${goal.y}, ${goal.z})`);
    bot.setControlState('sprint', false);

    const onGoalReached = () => {
      log(`[Move] Reached (${goal.x}, ${goal.y}, ${goal.z}), roaming again soon...`);
      bot.pathfinder.setGoal(null);
      setTimeout(() => roamInsideHouse(), 3000);
      bot.removeListener('goal_reached', onGoalReached);
    };

    bot.once('goal_reached', onGoalReached);
  }

  // Start roaming after spawn
  roamInsideHouse();

  // Prevent block breaking
  bot.dig = async () => {
    log(`[Block] Digging prevented.`);
  };

  bot.on('diggingCompleted', (block) => {
    log(`[Block] Prevented breaking at ${block.position}`);
    bot.stopDigging();
  });

  // Auto sleep at night
  setInterval(() => {
    if (bot.isSleeping) return;
    const time = bot.time.timeOfDay;
    if (time >= 13000 && time <= 23000) {
      const bedBlock = bot.findBlock({
        matching: block => bot.isABed(block),
        maxDistance: 10
      });
      if (bedBlock) {
        bot.sleep(bedBlock)
          .then(() => log(`[Sleep] Sleeping at ${bedBlock.position}`))
          .catch(err => log(`[Sleep] Failed to sleep: ${err.message}`));
      } else {
        log(`[Sleep] No bed found nearby.`);
      }
    }
  }, 5000);

  // Auto eat when hungry
  setInterval(() => {
    if (bot.food < 18) {
      const food = bot.inventory.items().find(item =>
        item.name.includes('bread') || item.name.includes('cooked') || item.name.includes('apple')
      );
      if (food) {
        bot.equip(food, 'hand')
          .then(() => bot.consume())
          .then(() => log(`[Eat] Ate ${food.name}`))
          .catch(err => log(`[Eat] Failed: ${err.message}`));
      }
    }
  }, 5000);

  // Jump every 5s
  setInterval(() => {
    if (bot.entity.onGround) {
      bot.setControlState('jump', true);
      setTimeout(() => bot.setControlState('jump', false), 500);
    }
  }, 5000);

  // Chat every 60s
  setInterval(() => {
    const msg = config.chatMessage || "I'm still active!";
    bot.chat(msg);
    log(`[Chat] ${msg}`);
  }, 60000);

  if (Array.isArray(config.chatMessages)) {
    setInterval(() => {
      config.chatMessages.forEach((msg, i) => {
        setTimeout(() => {
          bot.chat(msg);
          log(`[Chat] ${msg}`);
        }, i * 3000);
      });
    }, 60000);
  }

  // Exit house using door and resume roaming
  function exitHouse() {
    const doorBlock = bot.findBlock({
      matching: block => block.name.includes('door'),
      maxDistance: 10
    });

    if (!doorBlock) {
      log('[Door] No door found nearby.');
      roamInsideHouse(); // fallback
      return;
    }

    const doorPos = doorBlock.position;
    const isOpen = doorBlock.metadata & 0x4;

    if (!isOpen) {
      bot.activateBlock(doorBlock);
      log(`[Door] Opened door at ${doorPos}`);
    }

    const dirVec = bot.entity.position.minus(doorPos).normalize();
    const exitPos = doorPos.plus(dirVec.scaled(2)).floored();

    const goal = new GoalNear(exitPos.x, exitPos.y, exitPos.z, 1);
    bot.pathfinder.setGoal(goal);

    bot.once('goal_reached', () => {
      log(`[Move] Exited house through the door at ${doorPos}`);
      setTimeout(() => {
        bot.activateBlock(doorBlock);
        log(`[Door] Closed door at ${doorPos}`);
        setTimeout(roamInsideHouse, 3000); // Resume roaming
      }, 1000);
    });
  }

  // Trigger exit after 15 seconds (so bot roams a bit first)
  setTimeout(() => {
    exitHouse();
  }, 15000);
});

// Reconnect on crash or disconnect
bot.on('error', err => log(`[Error] ${err.message}`));
bot.on('end', () => {
  log(`[Disconnected] Bot disconnected. Reconnecting in 10 seconds...`);
  setTimeout(() => {
    require('child_process').spawn(process.argv[0], process.argv.slice(1), {
      stdio: 'inherit'
    });
  }, 10000);
});
