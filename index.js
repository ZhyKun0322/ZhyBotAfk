const mineflayer = require('mineflayer');
const { pathfinder, Movements, goals: { GoalBlock } } = require('mineflayer-pathfinder');
const fs = require('fs');
const config = require('./config.json');

const bot = mineflayer.createBot({
  host: config.host,
  port: config.port,
  username: config.username,
  version: config.version || false
});

bot.loadPlugin(pathfinder);

// 📝 Logger
function log(msg) {
  const time = new Date().toISOString();
  const logMsg = `[${time}] ${msg}`;
  console.log(logMsg);
  fs.appendFileSync('logs.txt', logMsg + '\n');
}

// 🔒 Auto login/register handler (OUTSIDE spawn!)
bot.on('messagestr', (message) => {
  const lower = message.toLowerCase();
  const password = config.loginCode;

  if (lower.includes('register') || lower.includes('not registered')) {
    bot.chat(`/register ${password} ${password}`);
    log(`[Login] Registered with password.`);
  } else if (lower.includes('login') || lower.includes('logged out')) {
    bot.chat(`/login ${password}`);
    log(`[Login] Sent login.`);
  }
});

// 🤖 Main bot logic
bot.once('spawn', () => {
  log(`[Bot] Spawned in the world.`);

  const mcData = require('minecraft-data')(bot.version);
  const movements = new Movements(bot, mcData);
  movements.allowSprinting = false; // Walk only
  bot.pathfinder.setMovements(movements);

  const center = config.walkCenter;
  const radius = 3;
  let angle = 0;

  // 🚶 Walk in circle
  function walkInCircle() {
    const x = center.x + Math.cos(angle) * radius;
    const z = center.z + Math.sin(angle) * radius;
    const y = center.y;

    const goal = new GoalBlock(Math.round(x), Math.round(y), Math.round(z));
    bot.pathfinder.setGoal(goal);
    log(`[Move] Going to (${goal.x}, ${goal.y}, ${goal.z})`);

    angle += Math.PI / 3;
    if (angle >= 2 * Math.PI) angle = 0;

    setTimeout(walkInCircle, 7000);
  }

  walkInCircle();

  // 🌙 Sleep at night
  bot.on('time', () => {
    if (bot.time.timeOfDay >= 13000 && bot.time.timeOfDay <= 23999 && !bot.isSleeping) {
      const bedBlock = bot.findBlock({
        matching: block => bot.isABed(block),
        maxDistance: 10
      });

      if (bedBlock) {
        bot.sleep(bedBlock)
          .then(() => log(`[Sleep] Sleeping in bed at ${bedBlock.position}`))
          .catch(err => log(`[Sleep] Failed: ${err.message}`));
      } else {
        log(`[Sleep] No nearby bed found.`);
      }
    }
  });

  // 🍗 Eat food when hungry
  setInterval(() => {
    if (bot.food < 18) {
      const foodItem = bot.inventory.items().find(item =>
        item.name.includes('bread') || item.name.includes('cooked') || item.name.includes('apple')
      );

      if (foodItem) {
        bot.equip(foodItem, 'hand')
          .then(() => bot.consume())
          .then(() => log(`[Eat] Ate ${foodItem.name}`))
          .catch(err => log(`[Eat] Failed: ${err.message}`));
      }
    }
  }, 5000);

  // 💬 Static chat message every 1 min
  setInterval(() => {
    const msg = config.chatMessage || "I'm still active!";
    bot.chat(msg);
    log(`[Chat] ${msg}`);
  }, 60000);

  // 💬 Multi-message chat
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

  // ⛏️ Block protection
  bot.on('diggingCompleted', block => {
    log(`[Block] Prevented breaking block at ${block.position}`);
    bot.stopDigging();
  });

  bot.on('diggingAborted', block => {
    log(`[Block] Digging aborted at ${block.position}`);
  });

  bot.dig = async function () {
    log(`[Block] Digging prevented by override.`);
    return;
  };

  // ⬆️ Jump every 5s
  setInterval(() => {
    if (bot.entity?.onGround) {
      bot.setControlState('jump', true);
      setTimeout(() => bot.setControlState('jump', false), 500);
    }
  }, 5000);
});

// 🔁 Auto reconnect on disconnect
bot.on('end', () => {
  log(`[Disconnected] Bot disconnected. Reconnecting...`);
  setTimeout(() => {
    require('child_process').spawn(process.argv[0], process.argv.slice(1), {
      stdio: 'inherit'
    });
  }, 10000);
});

bot.on('error', err => {
  log(`[Error] ${err.message}`);
});
