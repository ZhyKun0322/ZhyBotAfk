// Revised index.js for detailed bot routine control, no Discord integration
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
let currentTask = null;

function log(msg) {
  const time = new Date().toISOString();
  const line = `[${time}] ${msg}`;
  console.log(line);
  fs.appendFileSync('logs.txt', line + '\n');
  bot.chat(`[Log] ${msg}`);
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
    const text = msg.toString().toLowerCase();
    if (!alreadyLoggedIn && text.includes('register')) {
      bot.chat(`/register ${config.password} ${config.password}`);
      alreadyLoggedIn = true;
    } else if (!alreadyLoggedIn && text.includes('login')) {
      bot.chat(`/login ${config.password}`);
      alreadyLoggedIn = true;
    }

    if (text.includes('!stop')) {
      cancelAll();
      log('Bot stopped.');
    } else if (text.includes('!farm')) {
      cancelAll();
      farmRoutine();
    } else if (text.includes('!roam')) {
      cancelAll();
      houseRoamRoutine();
    } else if (text.includes('!sleep')) {
      cancelAll();
      sleepRoutine();
    }
  });
}

function cancelAll() {
  if (!bot) return;
  bot.clearControlStates();
  bot.pathfinder.setGoal(null);
  isRoaming = false;
  sleeping = false;
  currentTask = null;
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
  log('Starting farm routine');
  bot.chat(config.chatAnnouncements.farmingMessage);
  await goTo(config.exit);
  await goTo(config.farmMin);
  await farmCrops();
  await goTo(config.entrance);
  await goTo(config.houseCenter);
  await storeCrops();
}

async function houseRoamRoutine() {
  log('Starting roam routine');
  if (isRoaming) return;
  bot.chat(config.chatAnnouncements.houseMessage);
  isRoaming = true;
  const roam = async () => {
    if (!isRoaming || sleeping) return;
    const offsetX = Math.floor(Math.random() * 11) - 5;
    const offsetZ = Math.floor(Math.random() * 11) - 5;
    const pos = new Vec3(config.houseCenter.x + offsetX, config.houseCenter.y, config.houseCenter.z + offsetZ);
    await goTo(pos);
    setTimeout(roam, 4000);
  };
  roam();
}

async function sleepRoutine() {
  log('Attempting to sleep');
  const bed = bot.findBlock({ matching: b => b.name.endsWith('_bed'), maxDistance: config.searchRange });
  if (!bed) return;
  await goTo(config.entrance);
  await goTo(bed.position);
  try {
    await bot.sleep(bed);
    sleeping = true;
    bot.chat('[ZhyBot] Sleeping...');
    bot.once('wake', async () => {
      sleeping = false;
      bot.chat('[ZhyBot] Woke up!');
    });
  } catch (err) {
    log('Sleep error: ' + err.message);
  }
}

async function storeCrops() {
  for (let chestPos of config.chestPositions) {
    const chestBlock = bot.blockAt(new Vec3(chestPos.x, chestPos.y, chestPos.z));
    if (!chestBlock) continue;
    try {
      const chestWindow = await bot.openContainer(chestBlock);
      for (let item of bot.inventory.items()) {
        if (['wheat', 'carrot', 'potato'].includes(item.name)) {
          await chestWindow.deposit(item.type, null, item.count);
        }
      }
      chestWindow.close();
    } catch (err) {
      log('Error storing to chest: ' + err.message);
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
      if (crop.properties.age === 9) {
        try {
          await bot.dig(crop);
          await replantCrop(soil);
        } catch {}
      }
    }
  }
}

async function replantCrop(soil) {
  const seeds = bot.inventory.items().find(i => i.name.includes('seeds'));
  if (!seeds) return;
  try {
    await bot.equip(seeds, 'hand');
    await bot.placeBlock(soil, new Vec3(0, 1, 0));
  } catch (err) {
    log('Replant failed: ' + err.message);
  }
}

async function goTo(pos) {
  try {
    await bot.pathfinder.goto(new GoalBlock(pos.x, pos.y, pos.z));
  } catch (err) {
    log('Path error: ' + err.message);
  }
}

createBot();
