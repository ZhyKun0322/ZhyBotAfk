// 📁 mineflayer-bot-template/index.js // ✅ Bot walks, stops, looks around, jumps, chats, and handles LoginSecurity smarter

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

  // ⛨ Handle LoginSecurity smarter (register or login depending on server messages)
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
  const bedPos = bot.entity.position.clone(); // Assume bed is placed here
  bot.on('time', () => {
    if (bot.time.isNight() && !bot.isSleeping && bot.entity.onGround) {
      const bedBlock = bot.blockAt(bedPos);
      if (bedBlock && bot.isABed(bedBlock)) {
        bot.sleep(bedBlock).then(() => {
          log(`[Sleep] Bot is sleeping.`);
        }).catch(err => {
          log(`[Sleep] Failed to sleep: ${err.message}`);
        });
      }
    }
  });

  // 🔁 Circular movement every 1 minute
  const center = bot.entity.position.clone();
  let angle = 0;
  setInterval(() => {
    const radius = 5;
    angle += Math.PI / 4; // 45 degrees step
    const x = center.x + radius * Math.cos(angle);
    const z = center.z + radius * Math.sin(angle);
    const y = center.y;

    const goal = new GoalBlock(Math.floor(x), Math.floor(y), Math.floor(z));
    bot.pathfinder.setGoal(goal);
    log(`[Move] Walking in circle to ${x.toFixed(1)}, ${y.toFixed(1)}, ${z.toFixed(1)}`);
  }, 60 * 1000);

  // ⬆️ Jump every 5 seconds
  setInterval(() => {
    if (bot.entity.onGround) {
      bot.setControlState('jump', true);
      setTimeout(() => bot.setControlState('jump', false), 500);
    }
  }, 5000);

  // 💬 Main config.chatMessage (optional fallback)
  setInterval(() => {
    const msg = config.chatMessage || "I'm still active!";
    bot.chat(msg);
    log(`[Chat] ${msg}`);
  }, 60 * 1000);

  // 💬 Multi-line chat from config.chatMessages (1 msg every 3s, every 1 min)
  if (Array.isArray(config.chatMessages)) {
    setInterval(() => {
      config.chatMessages.forEach((msg, index) => {
        setTimeout(() => {
          bot.chat(msg);
          log(`[Chat] ${msg}`);
        }, index * 3000); // 3s spacing
      });
    }, 60 * 1000);
  }
});

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
