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
  bot.chat("Bot online!");

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

async function sleepRoutine() {
  if (sleeping) return;
  const bed = bot.findBlock({ matching: b => b.name.endsWith('_bed'), maxDistance: 6 });
  if (!bed) {
    log('[Sleep] No bed found');
    return;
  }

  await useDoors(config.entrance);
  await goTo(bed.position);
  try {
    await bot.sleep(bed);
    sleeping = true;
    bot.chat("Sleeping...");
    log('[Sleep] Bot is sleeping');
    bot.once('wake', async () => {
      sleeping = false;
      bot.chat("Woke up!");
      log('[Sleep] Bot woke up');
    });
  } catch (err) {
    log('[Sleep Error] ' + err.message);
  }
}

async function farmRoutine() {
  log('[Farm Routine] Starting');
  bot.chat("Going to farm.");
  await useDoors(config.exit);
  await goTo(config.farmMin);
  await farmCrops();
}

async function houseRoamRoutine() {
  if (isRoaming) return;
  isRoaming = true;
  bot.chat("Roaming inside the house.");
  log('[Roam Routine] Started');
  const roam = async () => {
    if (sleeping) return;
    const offsetX = Math.floor(Math.random() * 5) - 2;
    const offsetZ = Math.floor(Math.random() * 5) - 2;
    const pos = new Vec3(config.houseCenter.x + offsetX, config.houseCenter.y, config.houseCenter.z + offsetZ);
    await goTo(pos);
    setTimeout(roam, 4000);
  };
  roam();
}

async function farmCrops() {
  const min = config.farmMin;
  const max = config.farmMax;

  for (let x = min.x; x <= max.x; x++) {
    for (let z = min.z; z <= max.z; z++) {
      const soil = bot.blockAt(new Vec3(x, min.y, z));
      const crop = bot.blockAt(new Vec3(x, min.y + 1, z));
      if (!soil || soil.name !== 'farmland' || !crop) continue;

      const mature = crop.metadata >= 7;
      if (['wheat', 'carrots', 'potatoes'].includes(crop.name) && mature) {
        await bot.dig(crop);
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

async function useDoors(positions) {
  for (let pos of positions) {
    const door = bot.blockAt(new Vec3(pos.x, pos.y, pos.z));
    if (door && door.name.includes('door')) {
      await bot.activateBlock(door);
    }
  }
  await new Promise(r => setTimeout(r, 800)); // wait 0.8s
  for (let pos of positions) {
    const door = bot.blockAt(new Vec3(pos.x, pos.y, pos.z));
    if (door && door.name.includes('door')) {
      await bot.activateBlock(door); // close door
    }
  }
}

createBot();
