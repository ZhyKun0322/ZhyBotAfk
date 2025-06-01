const mineflayer = require('mineflayer');
const { pathfinder, Movements, goals: { GoalBlock } } = require('mineflayer-pathfinder');
const Vec3 = require('vec3');
const config = require('./config.json');

const bot = mineflayer.createBot({
  host: config.host,
  port: config.port,
  username: config.username,
  version: config.version || false,
});

bot.loadPlugin(pathfinder);

bot.once('spawn', () => {
  const mcData = require('minecraft-data')(bot.version);
  const defaultMove = new Movements(bot, mcData);
  bot.pathfinder.setMovements(defaultMove);

  const password = config.loginCode;
  const bedPos = config.bedPosition;
  const center = config.walkCenter;
  const radius = 3;
  let angle = 0;

  // Prevent block breaking
  bot.on('diggingCompleted', () => {
    bot.stopDigging();
  });

  bot.on('diggingAborted', () => {});

  bot.dig = async function () {
    return;
  };

  // Auto login/register
  bot.on('message', (jsonMsg) => {
    const message = jsonMsg.toString().toLowerCase();
    if (message.includes('register') || message.includes('not registered')) {
      bot.chat(`/register ${password} ${password}`);
    } else if (message.includes('login') || message.includes('logged out')) {
      bot.chat(`/login ${password}`);
    }
  });

  // Sleep at night
  bot.on('time', () => {
    if (bot.time.timeOfDay >= 13000 && bot.time.timeOfDay <= 23999 && !bot.isSleeping) {
      const bedVec = new Vec3(bedPos.x, bedPos.y, bedPos.z);
      const bedBlock = bot.blockAt(bedVec);
      if (bedBlock && bot.isABed(bedBlock)) {
        bot.pathfinder.setGoal(new GoalBlock(bedVec.x, bedVec.y, bedVec.z));
        bot.sleep(bedBlock).catch(() => {});
      }
    }
  });

  // Eat food when hungry
  setInterval(() => {
    if (bot.food < 18) {
      const foodItem = bot.inventory.items().find(item =>
        item.name.includes('bread') || item.name.includes('cooked') || item.name.includes('apple')
      );
      if (foodItem) {
        bot.equip(foodItem, 'hand').then(() => bot.consume().catch(() => {})).catch(() => {});
      }
    }
  }, 5000);

  // Walk in a circle
  function walkInCircle() {
    const x = center.x + Math.cos(angle) * radius;
    const z = center.z + Math.sin(angle) * radius;
    const y = center.y;

    const goal = new GoalBlock(Math.round(x), Math.round(y), Math.round(z));
    bot.pathfinder.setGoal(goal);

    angle += Math.PI / 3;
    if (angle >= 2 * Math.PI) angle = 0;

    setTimeout(walkInCircle, 7000);
  }

  walkInCircle();

  // Jump every 5s
  setInterval(() => {
    if (bot.entity.onGround) {
      bot.setControlState('jump', true);
      setTimeout(() => bot.setControlState('jump', false), 500);
    }
  }, 5000);

  // Chat single message
  setInterval(() => {
    const msg = config.chatMessage || "I'm still active!";
    bot.chat(msg);
  }, 60000);

  // Chat multiple messages
  if (Array.isArray(config.chatMessages)) {
    setInterval(() => {
      config.chatMessages.forEach((msg, i) => {
        setTimeout(() => {
          bot.chat(msg);
        }, i * 3000);
      });
    }, 60000);
  }
});

// Reconnect on disconnect
bot.on('error', () => {});
bot.on('end', () => {
  setTimeout(() => {
    require('child_process').spawn(process.argv[0], process.argv.slice(1), {
      stdio: 'inherit'
    });
  }, 10000);
});
