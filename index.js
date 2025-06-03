const mineflayer = require('mineflayer');
const { pathfinder, Movements, goals: { GoalBlock } } = require('mineflayer-pathfinder');
const Vec3 = require('vec3');
const mcDataLib = require('minecraft-data');
const fs = require('fs');
const config = require('./config.json');

let bot;
let mcData;
let defaultMove;
let sleeping = false;
let lastDay = -1;
let routineRunning = false;
let isEating = false;
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
    auth: 'offline',
  });

  bot.loadPlugin(pathfinder);

  bot.once('spawn', onSpawn);
  bot.on('error', err => console.error('[ERROR]', err));
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
  mcData = mcDataLib(bot.version);
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
      await farmRoutine();
    } else {
      await houseRoamRoutine();
    }
  }
  setTimeout(dailyRoutineLoop, 5000);
}

async function farmRoutine() {
  log("[Routine] Bot is going to farm.");
  bot.chat(config.chatAnnouncements.farmingMessage);
  await goTo(config.entrance);
  await useDoors(true);
  await goTo(config.exit);
  await farmCrops();
}

async function houseRoamRoutine() {
  log("[Routine] Bot is inside the house, roaming.");
  bot.chat(config.chatAnnouncements.houseMessage);
  if (isRoaming) return;
  isRoaming = true;
  const roam = async () => {
    if (sleeping) return;
    const offsetX = Math.floor(Math.random() * 11) - 5;
    const offsetZ = Math.floor(Math.random() * 11) - 5;
    const pos = new Vec3(config.houseCenter.x + offsetX, config.houseCenter.y, config.houseCenter.z + offsetZ);
    await goTo(pos);
    setTimeout(roam, 4000);
  };
  roam();
}

async function sleepRoutine() {
  const bed = bot.findBlock({ matching: b => b.name.endsWith('_bed'), maxDistance: config.searchRange });
  if (!bed) {
    log("[Sleep] No bed found.");
    return;
  }
  log("[Sleep] Going to sleep...");
  await goTo(config.entrance);
  await useDoors(false);
  await goTo(bed.position);
  try {
    await bot.sleep(bed);
    sleeping = true;
    bot.once('wake', async () => {
      log("[Sleep] Bot woke up.");
      sleeping = false;
      await postSleepActions();
    });
  } catch (err) {
    log("[Sleep Error] " + err.message);
  }
}

async function postSleepActions() {
  const currentDay = Math.floor(bot.time.age / 24000);
  if (currentDay % 2 === 1) {
    await storeCrops();
  }
}

async function storeCrops() {
  log("[Storage] Bot is storing crops.");
  for (const chestPos of config.chestPositions) {
    const chestBlock = bot.blockAt(new Vec3(chestPos.x, chestPos.y, chestPos.z));
    if (!chestBlock || !chestBlock.name.includes('chest')) continue;

    try {
      await goTo(chestBlock.position);
      const chestWindow = await bot.openContainer(chestBlock);
      for (let item of bot.inventory.items()) {
        if (mcData.items[item.type].food) {
          await chestWindow.deposit(item.type, null, item.count);
          log(`[Storage] Stored ${item.count}x ${item.name}`);
        }
      }
      chestWindow.close();
    } catch (err) {
      log("[Storage Error] " + err.message);
    }
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

      const blockData = mcData.blocksByName[crop.name];
      if (!blockData || !blockData.properties?.age) continue;

      const maxAge = Math.max(...blockData.properties.age);
      if (crop.metadata >= maxAge) {
        log(`[Farming] Harvesting ${crop.name} at ${crop.position}`);
        try {
          await bot.dig(crop);
        } catch (err) {
          log(`[Farming Error] ${err.message}`);
        }
      }
    }
  }
}

async function useDoors(open) {
  for (const doorPos of config.doorPositions) {
    const door = bot.blockAt(new Vec3(doorPos.x, doorPos.y, doorPos.z));
    if (door && door.name.includes('door')) {
      const isOpen = door.metadata & 0x4;
      if ((open && !isOpen) || (!open && isOpen)) {
        await bot.activateBlock(door);
        log(`[Door] ${open ? 'Opening' : 'Closing'} door at ${door.position}`);
      }
    }
  }
}

async function goTo(pos) {
  try {
    await bot.pathfinder.goto(new GoalBlock(pos.x, pos.y, pos.z));
  } catch (err) {
    log('[GoTo Error] ' + err.message);
  }
}

createBot();
