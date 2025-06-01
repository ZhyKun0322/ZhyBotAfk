const mineflayer = require('mineflayer');
const { pathfinder, Movements, goals: { GoalBlock } } = require('mineflayer-pathfinder');
const fs = require('fs');
const config = require('./config.json');

function log(msg) {
  const time = new Date().toISOString();
  console.log(`[${time}] ${msg}`);
  fs.appendFileSync('logs.txt', `[${time}] ${msg}\n`);
}

const bot = mineflayer.createBot({
  host: config.host,
  port: config.port,
  username: config.username,
  version: config.version || false,
});

bot.loadPlugin(pathfinder);

bot.once('spawn', () => {
  const mcData = require('minecraft-data')(bot.version);
  const movements = new Movements(bot, mcData);
  bot.pathfinder.setMovements(movements);

  const center = config.walkCenter;
  const radius = 3;
  let angle = 0;

  // 🛡️ Auto login/register
  const password = config.loginCode;
  bot.on('message', (jsonMsg) => {
    const message = jsonMsg.toString().toLowerCase();
    log(`[Server Message] ${message}`);
    if (message.includes('register') || message.includes('not registered')) {
      bot.chat(`/register ${password} ${password}`);
      log(`[Auth] Attempted to register.`);
    } else if (message.includes('login') || message.includes('logged out')) {
      bot.chat(`/login ${password}`);
      log(`[Auth] Attempted to login.`);
    }
  });

  // 🚶 Circle walking
  function walkCircle() {
    const x = center.x + Math.cos(angle) * radius;
    const z = center.z + Math.sin(angle) * radius;
    const y = center.y;

    const goal = new GoalBlock(Math.round(x), Math.round(y), Math.round(z));
    bot.pathfinder.setGoal(goal);
    log(`[Move] Walking to (${goal.x}, ${goal.y}, ${goal.z})`);

    angle += Math.PI / 3;
    if (angle >= 2 * Math.PI) angle = 0;

    setTimeout(walkCircle, 7000);
  }

  walkCircle();
});

// 🛠️ Reconnect on crash
bot.on('end', () => {
  log(`[Disconnected] Bot will reconnect...`);
  setTimeout(() => {
    require('child_process').spawn(process.argv[0], process.argv.slice(1), {
      stdio: 'inherit'
    });
  }, 10000);
});

bot.on('error', err => log(`[Error] ${err.message}`));
