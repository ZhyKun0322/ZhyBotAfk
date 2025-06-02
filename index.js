const mineflayer = require('mineflayer');
const { pathfinder, Movements, goals: { GoalBlock } } = require('mineflayer-pathfinder');
const Vec3 = require('vec3');
const mcDataLib = require('minecraft-data');
const config = require('./config.json');

let bot;
let mcData;
let defaultMove;
let sleeping = false;
let lastDay = -1;
let patrolIndex = 0;
let isEating = false;

function createBot() {
  bot = mineflayer.createBot({
    host: config.host,
    port: config.port,
    username: config.username,
    version: config.version || false,
    auth: 'offline' // or 'mojang' if needed
  });

  bot.loadPlugin(pathfinder);

  bot.once('login', () => console.log('✅ Bot logged in'));
  bot.once('spawn', onBotReady);

  bot.on('error', err => console.error('❌ Bot error:', err));
  bot.on('kicked', reason => {
    console.log('❌ Bot kicked:', reason);
    cleanupAndReconnect();
  });
  bot.on('end', () => {
    console.log('❌ Bot disconnected.');
    cleanupAndReconnect();
  });

  function cleanupAndReconnect() {
    if (!bot) return;
    bot.removeAllListeners();
    bot = null;
    sleeping = false;
    lastDay = -1;
    patrolIndex = 0;
    setTimeout(createBot, 5000);
  }

  async function onBotReady() {
    mcData = mcDataLib(bot.version);
    defaultMove = new Movements(bot, mcData);
    defaultMove.canDig = false;
    defaultMove.canOpenDoors = true;   // Allow opening doors
    defaultMove.canBreakDoors = false; // Don't break doors
    bot.pathfinder.setMovements(defaultMove);
    sleeping = false;
    lastDay = -1;
    patrolIndex = 0;

    bot.on('physicsTick', eatWhenHungry);

    dailyRoutineLoop();
    furnaceSmeltLoop();
  }

  // Helper to open door if closed
  async function openDoorIfNeeded(position) {
    const block = bot.blockAt(position);
    if (!block) return false;
    if (!block.name.endsWith('_door')) return false;

    // Check if door is closed
    // Door has property "open": true/false
    if (block.properties.open === 'false') {
      try {
        await bot.openDoor(block);
        // Small delay to let door open before moving through
        await new Promise(resolve => setTimeout(resolve, 500));
        return true;
      } catch (err) {
        console.error('Failed to open door:', err);
        return false;
      }
    }
    return true; // door already open
  }

  async function dailyRoutineLoop() {
    if (sleeping) return;

    try {
      const time = bot.time?.dayTime ?? bot.time?.timeOfDay ?? 0;
      const currentDay = Math.floor(bot.time.age / 24000);

      if (time >= 13000 && time <= 23458) {
        await goToBed();
      } else if (currentDay !== lastDay) {
        lastDay = currentDay;
        if (currentDay % 2 === 0) {
          roamLoop();
        } else {
          // Open door before walking to center (if needed)
          const doorPos = new Vec3(-1247, 72, -453);
          await openDoorIfNeeded(doorPos);
          await bot.pathfinder.goto(new GoalBlock(config.walkCenter.x, config.walkCenter.y, config.walkCenter.z));
          await farmCrops();
          await craftBread();
          await storeExcessItems();
        }
      }
    } catch (err) {
      console.error('Error in dailyRoutineLoop:', err);
    }

    setTimeout(dailyRoutineLoop, 5000);
  }

  async function roamLoop() {
    if (sleeping) return;
    const center = new Vec3(config.walkCenter.x, config.walkCenter.y, config.walkCenter.z);
    const points = [
      center.offset(-3, 0, 0),
      center.offset(3, 0, 0),
      center.offset(0, 0, -3),
      center.offset(0, 0, 3)
    ];

    try {
      const goal = points[patrolIndex];
      patrolIndex = (patrolIndex + 1) % points.length;

      // Open door first before roaming around
      const doorPos = new Vec3(-1247, 72, -453);
      await openDoorIfNeeded(doorPos);

      await bot.pathfinder.goto(new GoalBlock(goal.x, goal.y, goal.z));
    } catch (err) {
      console.error('Error in roamLoop:', err);
    }

    setTimeout(roamLoop, 5000);
  }

  // ... rest of your code unchanged, including eatWhenHungry, goToBed, findBed, farmCrops, etc.

}

createBot();
