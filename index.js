// index.js
const mineflayer = require('mineflayer');
const { pathfinder, Movements, goals: { GoalBlock } } = require('mineflayer-pathfinder');
const Vec3 = require('vec3');
const mcDataLoader = require('minecraft-data');
const fs = require('fs');
const config = require('./config.json');

let bot, mcData, defaultMove;
let sleeping = false;
let lastDay = -1;
let isRunning = true;
let isEating = false;

function log(msg) {
  const time = new Date().toISOString();
  const fullMsg = `[${time}] ${msg}`;
  console.log(fullMsg);
  fs.appendFileSync('logs.txt', fullMsg + '\n');
}

function createBot() {
  bot = mineflayer.createBot({
    host: config.host,
    port: config.port,
    username: config.username,
    version: config.version,
    auth: 'offline'
  });

  bot.loadPlugin(pathfinder);

  bot.once('spawn', () => {
    mcData = mcDataLoader(bot.version);
    defaultMove = new Movements(bot, mcData);
    defaultMove.allow1by1tallDoors = true;
    bot.pathfinder.setMovements(defaultMove);
    bot.on('chat', onChat);
    bot.on('physicsTick', eatIfHungry);
    runDailyLoop();
  });

  bot.on('end', () => setTimeout(createBot, 5000));
  bot.on('error', err => log(`[ERROR] ${err.message}`));
}

function onChat(username, message) {
  if (username === bot.username) return;
  if (message === '!stop') isRunning = false;
  if (message === '!start') isRunning = true;
  if (message === '!farm') farmRoutine();
  if (message === '!sleep') sleepRoutine();
  if (message === '!roam') houseRoamRoutine();
}

function eatIfHungry() {
  if (isEating || bot.food >= 18) return;
  const food = bot.inventory.items().find(i => mcData.items[i.type].food);
  if (food) {
    isEating = true;
    bot.equip(food, 'hand')
      .then(() => bot.consume())
      .finally(() => isEating = false);
  }
}

async function runDailyLoop() {
  while (true) {
    if (!isRunning || sleeping) {
      await new Promise(r => setTimeout(r, 3000));
      continue;
    }

    const dayTime = bot.time.dayTime;
    const currentDay = Math.floor(bot.time.age / 24000);

    if (dayTime >= 13000 && dayTime <= 23458) {
      await sleepRoutine();
    } else if (currentDay !== lastDay) {
      lastDay = currentDay;
      if (currentDay % 2 === 1) {
        await farmRoutine();
      } else {
        await houseRoamRoutine();
      }
    }

    await new Promise(r => setTimeout(r, 5000));
  }
}

async function sleepRoutine() {
  const bed = bot.findBlock({
    matching: b => b.name.endsWith('_bed'),
    maxDistance: config.searchRange
  });
  if (!bed) return;
  log('Trying to sleep...');
  try {
    await goTo(config.entrance);
    await goTo(bed.position);
    await bot.sleep(bed);
    sleeping = true;
    bot.once('wake', () => {
      log('Woke up!');
      sleeping = false;
    });
  } catch (e) {
    log(`Sleep failed: ${e.message}`);
  }
}

async function farmRoutine() {
  log('Farming routine started.');
  bot.chat(config.chatAnnouncements.farmingMessage);
  await goTo(config.exit);
  await harvestAndReplant();
  await goTo(config.entrance);
  await storeItems();
}

async function harvestAndReplant() {
  for (let x = config.farmMin.x; x <= config.farmMax.x; x++) {
    for (let z = config.farmMin.z; z <= config.farmMax.z; z++) {
      const y = config.farmMin.y;
      const crop = bot.blockAt(new Vec3(x, y + 1, z));
      const soil = bot.blockAt(new Vec3(x, y, z));
      if (crop && crop.properties.age === 9 && soil.name === 'farmland') {
        try {
          await bot.dig(crop);
          await replant(soil);
        } catch (e) {
          log(`Crop error at (${x},${y + 1},${z}): ${e.message}`);
        }
      }
    }
  }
}

async function replant(soil) {
  const seeds = bot.inventory.items().find(i => i.name.includes('seeds'));
  if (seeds) {
    await bot.equip(seeds, 'hand');
    await bot.placeBlock(soil, new Vec3(0, 1, 0));
  }
}

async function storeItems() {
  for (let chestPos of config.chestPositions) {
    const chestBlock = bot.blockAt(new Vec3(chestPos.x, chestPos.y, chestPos.z));
    if (!chestBlock || !bot.openContainer) continue;
    try {
      const chest = await bot.openContainer(chestBlock);
      for (let item of bot.inventory.items()) {
        if (['wheat', 'seeds'].includes(item.name)) {
          await chest.deposit(item.type, null, item.count);
        }
      }
      chest.close();
    } catch (e) {
      log(`Failed to store items: ${e.message}`);
    }
  }
}

async function houseRoamRoutine() {
  log('Roaming inside house.');
  bot.chat(config.chatAnnouncements.houseMessage);
  const bounds = { x: 5, z: 5 };
  for (let i = 0; i < 5; i++) {
    if (sleeping) return;
    const offsetX = Math.floor(Math.random() * (bounds.x * 2 + 1)) - bounds.x;
    const offsetZ = Math.floor(Math.random() * (bounds.z * 2 + 1)) - bounds.z;
    const target = new Vec3(config.houseCenter.x + offsetX, config.houseCenter.y, config.houseCenter.z + offsetZ);
    await goTo(target);
    await new Promise(r => setTimeout(r, 3000));
  }
}

async function goTo(pos) {
  try {
    await bot.pathfinder.goto(new GoalBlock(pos.x, pos.y, pos.z));
  } catch (e) {
    log(`Failed to path to (${pos.x}, ${pos.y}, ${pos.z}): ${e.message}`);
  }
}

createBot();
