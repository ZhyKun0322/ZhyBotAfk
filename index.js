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

function log(msg) {
  const time = new Date().toISOString();
  console.log(`[${time}] ${msg}`);
  fs.appendFileSync('logs.txt', `[${time}] ${msg}\n`);
}

bot.once('spawn', () => {
  const mcData = require('minecraft-data')(bot.version);
  const movements = new Movements(bot, mcData);
  movements.allowSprinting = false; // Walk, don't run
  bot.pathfinder.setMovements(movements);

  const center = config.walkCenter;
  const radius = 3;
  let angle = 0;

  // Auto login/register
  bot.on('message', (jsonMsg) => {
    const message = jsonMsg.toString().toLowerCase();
    const password = config.loginCode;
    if (message.includes('register') || message.includes('not registered')) {
      bot.chat(`/register ${password} ${password}`);
      log(`[LoginSecurity] Registered.`);
    } else if (message.includes('login') || message.includes('logged out')) {
      bot.chat(`/login ${password}`);
      log(`[LoginSecurity] Logged in.`);
    }
  });

  // Prevent digging
  bot.on('diggingCompleted', (block) => {
    log(`[Block] Prevented breaking block at ${block.position}`);
    bot.stopDigging();
  });

  bot.on('diggingAborted', (block) => {
    log(`[Block] Digging aborted at ${block.position}`);
  });

  bot.dig = async function () {
    log(`[Block] Digging prevented by override.`);
    return;
  };

  // Door opening
  bot.on('goal_reached', () => {
    const door = bot.findBlock({
      matching: block => block.name.includes('door'),
      maxDistance: 2
    });
    if (door) {
      const doorBlock = bot.blockAt(door.position);
      bot.activateBlock(doorBlock);
      log(`[Door] Opened door at ${door.position}`);
    }
  });

  // Sleep when night
  bot.on('time', () => {
    if (bot.time.timeOfDay >= 13000 && bot.time.timeOfDay <= 23999 && !bot.isSleeping) {
      const bed = bot.findBlock({
        matching: block => bot.isABed(block),
        maxDistance: 10
      });

      if (bed) {
        bot.sleep(bot.blockAt(bed))
          .then(() => log(`[Sleep] Sleeping in bed at ${bed}`))
          .catch(err => log(`[Sleep] Failed: ${err.message}`));
      } else {
        log(`[Sleep] No nearby bed found.`);
      }
    }
  });

  // Eat food
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

  // Circular walk
  function walkInCircle() {
    const x = center.x + Math.cos(angle) * radius;
    const z = center.z + Math.sin(angle) * radius;
    const y = center.y;

    const goal = new GoalBlock(Math.round(x), Math.round(y), Math.round(z));
    bot.pathfinder.setGoal(goal);
    log(`[Move] Walking to (${goal.x}, ${goal.y}, ${goal.z})`);

    angle += Math.PI / 3;
    if (angle >= 2 * Math.PI) angle = 0;

    setTimeout(walkInCircle, 7000);
  }

  walkInCircle();

  // Jump
  setInterval(() => {
    if (bot.entity.onGround) {
      bot.setControlState('jump', true);
      setTimeout(() => bot.setControlState('jump', false), 500);
    }
  }, 5000);

  // Static message
  setInterval(() => {
    const msg = config.chatMessage || "I'm still active!";
    bot.chat(msg);
    log(`[Chat] ${msg}`);
  }, 60000);

  // Multi-message
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

// Handle disconnect
bot.on('error', err => log(`[Error] ${err.message}`));
bot.on('end', () => {
  log(`[Disconnected] Bot disconnected. Reconnecting...`);
  setTimeout(() => {
    require('child_process').spawn(process.argv[0], process.argv.slice(1), {
      stdio: 'inherit'
    });
  }, 10000);
});
