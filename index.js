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
    auth: 'offline'
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
  log('[Farm Routine] Starting');
  if (config.house.exit) await goTo(config.house.exit);
  await goTo(config.farmMin);
  if (config.chatAnnouncements.enable) {
    bot.chat(config.chatAnnouncements.farmingMessage);
  }
  await farmCrops();
}

async function houseRoamRoutine() {
  log('[Roam Routine] Starting');
  if (isRoaming) return;
  isRoaming = true;
  const roam = async () => {
    if (sleeping) {
      isRoaming = false;
      return;
    }
    const offsetX = Math.floor(Math.random() * 5) - 2;
    const offsetZ = Math.floor(Math.random() * 5) - 2;
    const center = config.walkCenter;
    const pos = new Vec3(center.x + offsetX, center.y, center.z + offsetZ);
    await goTo(pos);
    setTimeout(roam, 4000);
  };
  roam();
}

async function sleepRoutine() {
  if (sleeping) return;
  const bed = bot.findBlock({
    matching: block => block.name.endsWith('_bed'),
    maxDistance: config.house.bedSearchRadius || 10
  });
  if (!bed) return;
  if (config.house.entrance) await goTo(config.house.entrance);
  await goTo(bed.position);
  try {
    await bot.sleep(bed);
    sleeping = true;
    bot.once('wake', async () => {
      sleeping = false;
      await postSleepActions();
    });
  } catch (err) {
    log('[Sleep Error] ' + err.message);
  }
}

async function postSleepActions() {
  const currentDay = Math.floor(bot.time.age / 24000);
  if (currentDay % 2 === 1) {
    await storeCrops();
  } else {
    await prepareInventoryForFarm();
  }
}

async function storeCrops() {
  const chestBlock = bot.findBlock({
    matching: b => b.name.includes('chest'),
    maxDistance: config.chestSearchRadius || 16
  });
  if (!chestBlock) return;
  await goTo(chestBlock.position);
  const chest = await bot.openContainer(chestBlock);
  for (let item of bot.inventory.items()) {
    if (!['carrot', 'potato', 'wheat'].includes(item.name)) continue;
    await chest.deposit(item.type, null, item.count);
  }
  chest.close();
  await ensureCarrotFood();
}

async function ensureCarrotFood() {
  const carrot = bot.inventory.items().find(i => i.name === 'carrot');
  if (!carrot || carrot.count < (config.inventory.keepFood.amount || 10)) {
    log('[Warning] Carrot food low');
  }
}

async function prepareInventoryForFarm() {
  // You can extend this later to actually fetch tools/seeds from a chest.
  log('[Prepare] Inventory check done.');
}

async function farmCrops() {
  const min = config.farmMin;
  const max = config.farmMax;
  for (let x = min.x; x <= max.x; x++) {
    for (let z = min.z; z <= max.z; z++) {
      const base = bot.blockAt(new Vec3(x, min.y, z));
      const crop = bot.blockAt(new Vec3(x, min.y + 1, z));
      if (!base || base.name !== 'farmland' || !crop) continue;
      if (
        ['wheat', 'carrots', 'potatoes'].includes(crop.name) &&
        crop.properties && crop.properties.age === 7
      ) {
        await bot.dig(crop);
        await replantCrop(base, crop.name);
      }
    }
  }
}

async function replantCrop(soil, crop) {
  let itemName = crop.includes('carrot') ? 'carrot' :
                 crop.includes('potato') ? 'potato' : 'wheat_seeds';
  const item = bot.inventory.items().find(i => i.name.includes(itemName));
  if (!item) return;
  await bot.equip(item, 'hand');
  await bot.placeBlock(soil, new Vec3(0, 1, 0));
}

async function goTo(pos) {
  try {
    await bot.pathfinder.goto(new GoalBlock(pos.x, pos.y, pos.z));
  } catch (err) {
    log('[GoTo Error] ' + err.message);
  }
}

createBot();
