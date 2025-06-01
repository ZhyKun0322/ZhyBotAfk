const mineflayer = require('mineflayer');
const { pathfinder, Movements, goals: { GoalBlock } } = require('mineflayer-pathfinder');
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

// Listen to low-level client errors to avoid uncaught exceptions
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

  // House center and size for walking
  const houseCenter = new Vec3(-1244, 72, -448);
  const houseSize = 11; // 11x11 blocks

  // Calculate corners of the house perimeter to walk around
  const points = [
    new Vec3(houseCenter.x - Math.floor(houseSize / 2), houseCenter.y, houseCenter.z - Math.floor(houseSize / 2)),
    new Vec3(houseCenter.x + Math.floor(houseSize / 2), houseCenter.y, houseCenter.z - Math.floor(houseSize / 2)),
    new Vec3(houseCenter.x + Math.floor(houseSize / 2), houseCenter.y, houseCenter.z + Math.floor(houseSize / 2)),
    new Vec3(houseCenter.x - Math.floor(houseSize / 2), houseCenter.y, houseCenter.z + Math.floor(houseSize / 2)),
  ];

  let currentPoint = 0;

  function walkAroundHouse() {
    const goal = new GoalBlock(points[currentPoint].x, points[currentPoint].y, points[currentPoint].z);
    bot.pathfinder.setGoal(goal);
    log(`[Move] Walking to house corner ${currentPoint + 1}: (${goal.x}, ${goal.y}, ${goal.z})`);

    const onGoalReached = () => {
      log(`[Move] Reached house corner ${currentPoint + 1}`);
      currentPoint = (currentPoint + 1) % points.length;
      bot.pathfinder.setGoal(null);
      setTimeout(walkAroundHouse, 3000);
      bot.removeListener('goal_reached', onGoalReached);
    };

    bot.once('goal_reached', onGoalReached);
  }

  walkAroundHouse();

  // Prevent block breaking
  bot.dig = async () => {
    log(`[Block] Digging prevented.`);
  };

  bot.on('diggingCompleted', (block) => {
    log(`[Block] Prevented breaking at ${block.position}`);
    bot.stopDigging();
  });

  // Auto sleep at night
  bot.on('time', () => {
    if (bot.time.timeOfDay >= 13000 && bot.time.timeOfDay <= 23999 && !bot.isSleeping) {
      const bedPos = bot.findBlock({
        matching: block => bot.isABed(block),
        maxDistance: 10
      });

      if (bedPos) {
        const bedBlock = bot.blockAt(bedPos.position || bedPos);
        bot.sleep(bedBlock)
          .then(() => log(`[Sleep] Sleeping at ${bedBlock.position}`))
          .catch(err => log(`[Sleep] Failed: ${err.message}`));
      } else {
        log(`[Sleep] No bed found nearby.`);
      }
    }
  });

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
