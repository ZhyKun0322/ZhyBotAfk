// 📁 mineflayer-bot-template/index.js

const mineflayer = require('mineflayer');
const { pathfinder, Movements, goals: { GoalBlock } } = require('mineflayer-pathfinder');
const fs = require('fs');
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

  // ⛨ LoginSecurity
  bot.on('message', (jsonMsg) => {
    const message = jsonMsg.toString().toLowerCase();

    if (message.includes('register') || message.includes('not registered')) {
      bot.chat(`/register ${password} ${password}`);
      log(`[LoginSecurity] Sent register command`);
    } else if (message.includes('login') || message.includes('logged out')) {
      bot.chat(`/login ${password}`);
      log(`[LoginSecurity] Sent login command`);
    }
  });

  // 🌙 Sleep at night
  const bedPosition = { x: -1289, y: 73, z: -416 };
  bot.on('time', () => {
    if (isNightTime() && !bot.isSleeping && bot.entity.onGround) {
      const bedBlock = bot.blockAt(bedPosition);
      if (bedBlock && bot.isABed(bedBlock)) {
        bot.sleep(bedBlock).then(() => {
          log(`[Sleep] Bot is sleeping at the bed.`);
        }).catch(err => {
          log(`[Sleep] Failed to sleep: ${err.message}`);
        });
      }
    }
  });

  function isNightTime() {
    const time = bot.time.timeOfDay || 0;
    return time >= 13000 && time <= 23000;
  }

  // 🍗 Auto-eat
  setInterval(() => {
    if (bot.food < 18) {
      const foodItem = bot.inventory.items().find(item =>
        item.name.includes('bread') || item.name.includes('cooked') || item.name.includes('apple')
      );
      if (foodItem) {
        bot.equip(foodItem, 'hand').then(() => {
          bot.consume().then(() => {
            log(`[Eat] Ate ${foodItem.name}`);
          }).catch(err => log(`[Eat] Error: ${err.message}`));
        }).catch(err => log(`[Equip] Error: ${err.message}`));
      }
    }
  }, 5000);

  // 🚶 Walk and look
  function walkAndLook() {
    const pos = bot.entity.position;
    const x = pos.x + Math.floor(Math.random() * 10 - 5);
    const y = pos.y;
    const z = pos.z + Math.floor(Math.random() * 10 - 5);
    const goal = new GoalBlock(Math.floor(x), Math.floor(y), Math.floor(z));

    bot.pathfinder.setGoal(goal);
    log(`[Move] Walking to ${x.toFixed(1)}, ${y.toFixed(1)}, ${z.toFixed(1)}`);

    setTimeout(() => {
      bot.pathfinder.setGoal(null);
      log(`[Move] Stopped to look around.`);

      const yaw = bot.entity.yaw;
      bot.look(yaw - Math.PI / 2, 0, true, () => {
        setTimeout(() => {
          bot.look(yaw + Math.PI / 2, 0, true, () => {
            setTimeout(() => walkAndLook(), 1000);
          });
        }, 2000);
      });
    }, 6000);
  }

  walkAndLook();

  // ⬆️ Jump every 5s
  setInterval(() => {
    if (bot.entity.onGround) {
      bot.setControlState('jump', true);
      setTimeout(() => bot.setControlState('jump', false), 500);
    }
  }, 5000);

  // 💬 Chat
  setInterval(() => {
    const msg = config.chatMessage || "I'm still active!";
    bot.chat(msg);
    log(`[Chat] ${msg}`);
  }, 60 * 1000);

  // 💬 Multi-message chat
  if (Array.isArray(config.chatMessages)) {
    setInterval(() => {
      config.chatMessages.forEach((msg, index) => {
        setTimeout(() => {
          bot.chat(msg);
          log(`[Chat] ${msg}`);
        }, index * 3000);
      });
    }, 60 * 1000);
  }
});

// 🧠 Log error
bot.on('error', err => log(`[Error] ${err.message}`));
bot.on('end', () => log(`[Info] Bot disconnected.`));

// 🔁 Auto-reconnect
bot.on('end', () => {
  log(`[Reconnect] Attempting to restart bot in 10 seconds...`);
  setTimeout(() => {
    require('child_process').spawn(process.argv[0], process.argv.slice(1), {
      stdio: 'inherit'
    });
  }, 10000);
});

// 📝 Logger
function log(message) {
  const timestamp = new Date().toISOString();
  const fullMessage = `[${timestamp}] ${message}`;
  console.log(fullMessage);
  fs.appendFileSync('logs.txt', fullMessage + '\n');
    }
