const mineflayer = require('mineflayer');
const { pathfinder, Movements, goals: { GoalBlock } } = require('mineflayer-pathfinder');
const fs = require('fs');
const config = require('./config.json');

let angle = 0;
let movementInterval;

function log(msg) {
  const time = new Date().toISOString();
  const line = `[${time}] ${msg}`;
  console.log(line);
  fs.appendFileSync('logs.txt', line + '\n');
}

function createBot() {
  const bot = mineflayer.createBot({
    host: config.host,
    port: config.port,
    username: config.username,
    version: config.version || false
  });

  bot.loadPlugin(pathfinder);

  // 🔐 Login/Register
  bot.on('messagestr', (message) => {
    const lower = message.toLowerCase();
    if (lower.includes('register') || lower.includes('not registered')) {
      bot.chat(`/register ${config.loginCode} ${config.loginCode}`);
      log('[Login] Sent /register');
    } else if (lower.includes('login') || lower.includes('logged out')) {
      bot.chat(`/login ${config.loginCode}`);
      log('[Login] Sent /login');
    }
  });

  // ✅ Main logic
  bot.once('spawn', () => {
    log('[Spawn] Bot has spawned');

    const mcData = require('minecraft-data')(bot.version);
    const movements = new Movements(bot, mcData);
    movements.allowSprinting = false;
    bot.pathfinder.setMovements(movements);

    const center = config.walkCenter || { x: 0, y: 64, z: 0 };
    const radius = 3;

    function walkCircle() {
      const x = center.x + Math.cos(angle) * radius;
      const z = center.z + Math.sin(angle) * radius;
      const y = center.y;

      const goal = new GoalBlock(Math.round(x), Math.round(y), Math.round(z));
      bot.pathfinder.setGoal(goal);
      log(`[Move] Walking to (${goal.x}, ${goal.y}, ${goal.z})`);

      angle += Math.PI / 3;
      if (angle >= 2 * Math.PI) angle = 0;
    }

    walkCircle();
    movementInterval = setInterval(walkCircle, 8000);

    // 🍗 Eat food
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

    // 💤 Sleep at night
    bot.on('time', () => {
      if (bot.time.timeOfDay >= 13000 && bot.time.timeOfDay <= 23999 && !bot.isSleeping) {
        const bed = bot.findBlock({ matching: b => bot.isABed(b), maxDistance: 10 });
        if (bed) {
          bot.sleep(bed)
            .then(() => log(`[Sleep] Slept in bed at ${bed.position}`))
            .catch(err => log(`[Sleep] Failed: ${err.message}`));
        }
      }
    });

    // 💬 Chat message every minute
    if (config.chatMessages?.length) {
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

  // 🔁 Reconnect on disconnect
  bot.on('end', () => {
    log('[Bot] Disconnected. Reconnecting...');
    if (movementInterval) clearInterval(movementInterval);
    setTimeout(() => createBot(), 10000);
  });

  bot.on('error', err => log(`[Error] ${err.message}`));
}

createBot();
