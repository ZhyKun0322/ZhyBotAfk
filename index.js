// 📁 mineflayer-bot-template/index.js // ✅ Bot walks, stops, looks left and right, then walks again

const mineflayer = require('mineflayer'); const { pathfinder, Movements, goals: { GoalBlock } } = require('mineflayer-pathfinder'); const fs = require('fs'); const config = require('./config.json');

const bot = mineflayer.createBot({ host: config.host, port: config.port, username: config.username, version: config.version || false, });

bot.loadPlugin(pathfinder);

bot.once('spawn', () => { const mcData = require('minecraft-data')(bot.version); const defaultMove = new Movements(bot, mcData); bot.pathfinder.setMovements(defaultMove);

function walkAndLook() { const pos = bot.entity.position; const x = pos.x + Math.floor(Math.random() * 20 - 10); const y = pos.y; const z = pos.z + Math.floor(Math.random() * 20 - 10); const goal = new GoalBlock(Math.floor(x), Math.floor(y), Math.floor(z));

bot.pathfinder.setGoal(goal);
log(`[Move] Walking to ${x.toFixed(1)}, ${y.toFixed(1)}, ${z.toFixed(1)}`);

const stopAfter = 6000; // Stop after 6 seconds of walking
setTimeout(() => {
  bot.pathfinder.setGoal(null); // Stop walking
  log(`[Move] Stopped to look around.`);

  const yaw = bot.entity.yaw;

  // Look left
  bot.look(yaw - Math.PI / 2, 0, true, () => {
    setTimeout(() => {
      // Look right
      bot.look(yaw + Math.PI / 2, 0, true, () => {
        setTimeout(() => {
          walkAndLook(); // Repeat cycle
        }, 1000);
      });
    }, 2000);
  });
}, stopAfter);

}

walkAndLook();

// Jump every 5 seconds setInterval(() => { if (bot.entity.onGround) { bot.setControlState('jump', true); setTimeout(() => bot.setControlState('jump', false), 500); } }, 5000);

// Chat every 1 minute setInterval(() => { const msg = config.chatMessage || "I'm still active!"; bot.chat(msg); log([Chat] ${msg}); }, 60 * 1000); });

bot.on('error', err => log([Error] ${err.message})); bot.on('end', () => log([Info] Bot disconnected.));

function log(message) { const timestamp = new Date().toISOString(); const fullMessage = [${timestamp}] ${message}; console.log(fullMessage); fs.appendFileSync('logs.txt', fullMessage + '\n'); }

