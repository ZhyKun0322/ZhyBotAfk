const mineflayer = require('mineflayer');
const vec3 = require('vec3');
const { pathfinder, Movements, goals: { GoalNear, GoalBlock } } = require('mineflayer-pathfinder');
const mcData = require('minecraft-data');

const config = require('./config.json');

let bot;
let mcDataInstance;
let defaultMove;
let dayCount = 1;
let routineInterval; // will hold setTimeout reference

function createBot() {
  bot = mineflayer.createBot({
    host: config.host,
    port: config.port,
    username: config.username,
    version: config.version
  });

  bot.loadPlugin(pathfinder);

  bot.once('login', () => {
    log('Logged in, sending /login command...');
    bot.chat(`/login ${config.password}`);
  });

  bot.on('chat', (username, message) => {
    if (username === bot.username) return; // ignore own messages
    const lower = message.toLowerCase();
    if (lower.includes('please login') || lower.includes('login')) {
      log('Detected login prompt, sending /login command again...');
      bot.chat(`/login ${config.password}`);
    }
  });

  bot.once('spawn', () => {
    mcDataInstance = mcData(bot.version);
    defaultMove = new Movements(bot, mcDataInstance);
    defaultMove.canDig = true;
    bot.pathfinder.setMovements(defaultMove);

    startDailyRoutine();
  });

  bot.on('kicked', (reason) => {
    log(`Kicked from server: ${reason}. Reconnecting in 10 seconds...`);
    clearTimeout(routineInterval);
    setTimeout(createBot, 10000);
  });

  bot.on('end', () => {
    log('Bot disconnected from server. Reconnecting in 10 seconds...');
    clearTimeout(routineInterval);
    setTimeout(createBot, 10000);
  });

  bot.on('error', (err) => {
    log(`Error: ${err.message}`);
  });
}

createBot();

function log(msg) {
  console.log(`[BOT] ${msg}`);
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function openDoor() {
  const doorPos = vec3(config.door.x, config.door.y, config.door.z);
  const block = bot.blockAt(doorPos);
  if (!block) {
    log('Door block not found!');
    return false;
  }
  if (block.name.includes('door')) {
    try {
      await bot.activateBlock(block);
      log('Door opened/activated');
      await delay(1000);
    } catch (err) {
      log('Error activating door: ' + err.message);
    }
  }
  return true;
}

async function sleepInBed() {
  // Fix: find all bed block IDs (any color)
  const bedIds = Object.values(mcDataInstance.blocks)
    .filter(b => b.name.endsWith('_bed'))
    .map(b => b.id);

  const bedBlock = bot.findBlock({
    matching: bedIds,
    maxDistance: config.searchRange
  });

  if (!bedBlock) {
    log('No bed found to sleep in.');
    return false;
  }
  try {
    await bot.sleep(bedBlock);
    log('Slept in bed successfully.');
    return true;
  } catch (err) {
    log('Could not sleep in bed: ' + err.message);
    return false;
  }
}

async function roamAroundCenter() {
  const center = vec3(config.walkCenter.x, config.walkCenter.y, config.walkCenter.z);
  const radius = 3;
  const points = [
    center.offset(radius, 0, radius),
    center.offset(-radius, 0, radius),
    center.offset(-radius, 0, -radius),
    center.offset(radius, 0, -radius)
  ];
  log('Roaming around house center...');
  for (const point of points) {
    await bot.pathfinder.goto(new GoalNear(point.x, point.y, point.z, 1));
  }
  log('Finished roaming around house center.');
}

async function eatFood() {
  if (bot.food >= 20) return;
  const foodItems = bot.inventory.items().filter(item => {
    return mcDataInstance.foodsById[item.type] !== undefined;
  });
  if (foodItems.length === 0) {
    log('No food to eat.');
    return;
  }
  try {
    await bot.equip(foodItems[0], 'hand');
    await bot.consume();
    log('Ate some food to restore hunger.');
  } catch (err) {
    log('Error eating food: ' + err.message);
  }
}

async function harvestAndReplantFarm() {
  log('Starting farm harvest and replant...');
  const min = vec3(config.farmMin.x, config.farmMin.y, config.farmMin.z);
  const max = vec3(config.farmMax.x, config.farmMax.y, config.farmMax.z);

  for (let x = min.x; x <= max.x; x++) {
    for (let z = min.z; z <= max.z; z++) {
      const pos = vec3(x, min.y, z);
      const block = bot.blockAt(pos);
      if (!block) continue;

      if (block.name === 'wheat' && block.properties.age === '7') {
        try {
          await bot.pathfinder.goto(new GoalNear(pos.x, pos.y, pos.z, 1));
          await bot.dig(block);
          log(`Harvested wheat at ${pos.x},${pos.y},${pos.z}`);

          const seed = bot.inventory.items().find(i => i.name === 'wheat_seeds');
          if (seed) {
            await bot.placeBlock(bot.blockAt(pos.offset(0, -1, 0)), new vec3(0, 1, 0));
            log(`Replanted wheat seeds at ${pos.x},${pos.y},${pos.z}`);
          }
        } catch (err) {
          log('Error harvesting/replanting: ' + err.message);
        }
      }
    }
  }
  log('Finished farm harvest/replant.');
}

async function useBlockNearby(name) {
  const blockId = mcDataInstance.blocksByName[name] ? mcDataInstance.blocksByName[name].id : null;
  if (!blockId) {
    log(`Block ${name} not found in mcData.`);
    return null;
  }
  const block = bot.findBlock({
    matching: blockId,
    maxDistance: config.searchRange
  });
  if (!block) {
    log(`No ${name} found nearby.`);
    return null;
  }
  try {
    await bot.pathfinder.goto(new GoalNear(block.position.x, block.position.y, block.position.z, 1));
    await bot.activateBlock(block);
    log(`Used ${name} at ${block.position.x},${block.position.y},${block.position.z}`);
    return block;
  } catch (err) {
    log(`Failed to use ${name}: ${err.message}`);
    return null;
  }
}

async function dailyRoutine() {
  log(`Starting Day ${dayCount} routine.`);

  await openDoor();
  await eatFood();

  if (dayCount % 2 === 1) {
    if (config.chatAnnouncements.enable) {
      bot.chat(config.chatAnnouncements.farmingMessage);
    }
    await harvestAndReplantFarm();
    await sleepInBed();
  } else {
    await roamAroundCenter();
    await sleepInBed();
  }

  log(`Day ${dayCount} routine finished.`);
  dayCount++;

  if (dayCount > 4) dayCount = 1;

  routineInterval = setTimeout(dailyRoutine, 20 * 60 * 1000);
}

function startDailyRoutine() {
  log('Starting daily routine loop...');
  dailyRoutine();
}

// Auto eat every minute
setInterval(() => {
  if (bot && bot.isAlive) eatFood();
}, 60 * 1000);
