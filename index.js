const mineflayer = require('mineflayer');
const { pathfinder, Movements, goals: { GoalBlock } } = require('mineflayer-pathfinder');
const Vec3 = require('vec3');
const mcDataLoader = require('minecraft-data');
const fs = require('fs');
const config = require('./config.json');

let bot, mcData, defaultMove;
let lastDay = -1;
let isEating = false;
let sleeping = false;
let routineRunning = false;
let isRoaming = false;
let alreadyLoggedIn = false;

function log(msg) {
  const time = new Date().toISOString();
  const line = `[${time}] ${msg}`;
  console.log(line);
  fs.appendFileSync('logs.txt', line + '\n');
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
  bot.once('spawn', onSpawn);
  bot.on('error', err => log(`[ERROR] ${err.message}`));
  bot.on('end', () => setTimeout(createBot, 5000));

  bot.on('message', msg => {
    if (alreadyLoggedIn) return;
    const text = msg.toString().toLowerCase();
    if (text.includes('register')) {
      bot.chat(`/register ${config.password} ${config.password}`);
      alreadyLoggedIn = true;
    } else if (text.includes('login')) {
      bot.chat(`/login ${config.password}`);
      alreadyLoggedIn = true;
    }
  });
}

function onSpawn() {
  mcData = mcDataLoader(bot.version);
  defaultMove = new Movements(bot, mcData);
  defaultMove.allow1by1tallDoors = true;
  bot.pathfinder.setMovements(defaultMove);
  bot.on('physicsTick', eatIfHungry);

  if (!routineRunning) {
    routineRunning = true;
    dailyRoutineLoop();
  }
}

function eatIfHungry() {
  if (isEating || bot.food >= 18) return;
  const food = bot.inventory.items().find(i => mcData.items[i.type].food);
  if (food) {
    isEating = true;
    bot.equip(food, 'hand')
      .then(() => bot.consume())
      .catch(err => log(`[Eat Error] ${err.message}`))
      .finally(() => isEating = false);
  }
}

async function dailyRoutineLoop() {
  if (!bot || sleeping) return;

  const time = bot.time.dayTime;
  const currentDay = Math.floor(bot.time.age / 24000);

  if (time >= 13000 && time <= 23458) {
    await sleepRoutine();
  } else if (currentDay !== lastDay) {
    lastDay = currentDay;
    if (currentDay % 2 === 1) {
      bot.chat(config.chatAnnouncements.farmingMessage);
      log('[Routine] Farming');
      await farmRoutine();
    } else {
      bot.chat(config.chatAnnouncements.houseMessage);
      log('[Routine] Roaming in house');
      await houseRoamRoutine();
    }
  }
  setTimeout(dailyRoutineLoop, 5000);
}

async function farmRoutine() {
  await useDoor(config.exit);
  await farmCrops();
}

async function houseRoamRoutine() {
  if (isRoaming) return;
  isRoaming = true;
  const roam = async () => {
    if (sleeping) return;
    const offsetX = Math.floor(Math.random() * 5) - 2;
    const offsetZ = Math.floor(Math.random() * 5) - 2;
    const pos = new Vec3(config.houseCenter.x + offsetX, config.houseCenter.y, config.houseCenter.z + offsetZ);
    await goTo(pos);
    setTimeout(roam, 5000);
  };
  roam();
}

async function sleepRoutine() {
  const bed = bot.findBlock({ matching: block => block.name.includes('bed'), maxDistance: config.searchRange });
  if (!bed) return log('[Sleep] No bed found');

  await useDoor(config.entrance);
  await goTo(bed.position);

  try {
    await bot.sleep(bed);
    sleeping = true;
    log('[Sleep] Bot is sleeping');
    bot.once('wake', async () => {
      sleeping = false;
      log('[Sleep] Woke up');
      bot.chat('[ZhyBot] Woke up!');
      await delay(1500);
      await useDoor(config.exit);
      await storeCrops();
    });
  } catch (err) {
    log(`[Sleep Error] ${err.message}`);
  }
}

async function farmCrops() {
  const min = config.farmMin;
  const max = config.farmMax;
  for (let x = min.x; x <= max.x; x++) {
    for (let z = min.z; z <= max.z; z++) {
      const soil = bot.blockAt(new Vec3(x, min.y, z));
      const crop = bot.blockAt(new Vec3(x, min.y + 1, z));
      if (!soil || soil.name !== 'farmland' || !crop) continue;
      const age = crop.properties?.age ?? -1;
      if (age === 9) {
        try {
          await bot.dig(crop);
          await replantCrop(soil);
        } catch (err) {
          log(`[Farm Error] ${err.message}`);
        }
      }
    }
  }
}

async function replantCrop(soil) {
  const seeds = bot.inventory.items().find(i => i.name.includes('seeds'));
  if (!seeds) return log('[Replant] No seeds found');
  await bot.equip(seeds, 'hand');
  await bot.placeBlock(soil, new Vec3(0, 1, 0));
}

async function storeCrops() {
  for (const pos of config.chestPositions) {
    const chestBlock = bot.blockAt(new Vec3(pos.x, pos.y, pos.z));
    if (!chestBlock || !chestBlock.name.includes('chest')) continue;
    try {
      await goTo(chestBlock.position);
      const chest = await bot.openContainer(chestBlock);
      for (const item of bot.inventory.items()) {
        if (item.name.includes('wheat') || item.name.includes('seeds')) {
          await chest.deposit(item.type, null, item.count);
        }
      }
      chest.close();
      log('[Storage] Items stored successfully');
    } catch (err) {
      log(`[Chest Error] ${err.message}`);
    }
  }
}

async function useDoor(positions) {
  for (const pos of Array.isArray(positions) ? positions : [positions]) {
    const door = bot.blockAt(new Vec3(pos.x, pos.y, pos.z));
    if (door && door.name.includes('door')) {
      try {
        await bot.activateBlock(door);
        await delay(1000);
        await bot.activateBlock(door); // Close it back
      } catch (err) {
        log(`[Door Error] ${err.message}`);
      }
    }
  }
}

async function goTo(pos) {
  try {
    await bot.pathfinder.goto(new GoalBlock(pos.x, pos.y, pos.z));
  } catch (err) {
    log(`[Path Error] ${err.message}`);
  }
}

function delay(ms) {
  return new Promise(res => setTimeout(res, ms));
}

createBot();
