// Updated index.js with chat commands, auto farming, storing, roaming, door logic, and sleep

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
let currentTask = 'Idle';

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

  bot.on('message', async msg => {
    if (!alreadyLoggedIn) {
      const text = msg.toString().toLowerCase();
      if (text.includes('register')) {
        bot.chat(`/register ${config.password} ${config.password}`);
        alreadyLoggedIn = true;
      } else if (text.includes('login')) {
        bot.chat(`/login ${config.password}`);
        alreadyLoggedIn = true;
      }
    }

    const username = msg.username;
    const content = msg.toString();
    if (!username || username === bot.username) return;

    // Command handler
    switch (content.trim()) {
      case '!status':
        bot.chat(`[ZhyBot] Current task: ${currentTask}`);
        break;
      case '!sleep':
        await sleepRoutine();
        break;
      case '!farm':
        await farmRoutine();
        break;
      case '!roam':
        await houseRoamRoutine();
        break;
      case '!store':
        await storeCrops();
        break;
      case '!come':
        const player = bot.players[username]?.entity;
        if (player) await goTo(player.position);
        break;
      case '!stop':
        bot.pathfinder.setGoal(null);
        currentTask = 'Idle';
        break;
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

async function openAndCloseDoors() {
  for (const doorPos of config.doorPositions) {
    const doorBlock = bot.blockAt(new Vec3(doorPos.x, doorPos.y, doorPos.z));
    if (doorBlock && bot.openBlock) {
      try {
        await bot.activateBlock(doorBlock);
        await new Promise(resolve => setTimeout(resolve, 1000));
      } catch (e) { }
    }
  }
}

async function farmRoutine() {
  currentTask = 'Farming';
  log('[Farm Routine] Starting');
  bot.chat(config.chatAnnouncements.farmingMessage);
  await goTo(config.exit);
  await openAndCloseDoors();
  await goTo(config.farmMin);
  await farmCrops();
  await goTo(config.entrance);
  await openAndCloseDoors();
}

async function houseRoamRoutine() {
  currentTask = 'Roaming';
  if (isRoaming) return;
  isRoaming = true;
  bot.chat(config.chatAnnouncements.houseMessage);
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
  if (!bed) return;
  currentTask = 'Sleeping';
  await goTo(config.entrance);
  await openAndCloseDoors();
  await goTo(bed.position);
  try {
    await bot.sleep(bed);
    sleeping = true;
    bot.once('wake', async () => {
      sleeping = false;
      currentTask = 'Idle';
      bot.chat('[ZhyBot] Woke up!');
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
  }
}

async function storeCrops() {
  currentTask = 'Storing';
  for (let chestPos of config.chestPositions) {
    const chestBlock = bot.blockAt(new Vec3(chestPos.x, chestPos.y, chestPos.z));
    if (!chestBlock) continue;
    try {
      await goTo(chestBlock.position);
      const chest = await bot.openContainer(chestBlock);
      for (let item of bot.inventory.items()) {
        if (['wheat', 'seeds', 'potato'].includes(item.name)) {
          await chest.deposit(item.type, null, item.count);
        }
      }
      chest.close();
      break;
    } catch (e) {
      log('[Store Error] ' + e.message);
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
      if ((['wheat', 'carrots', 'potatoes'].includes(crop.name)) && crop.metadata === 9) {
        try {
          await bot.dig(crop);
          await replantCrop(soil, crop.name);
        } catch (e) { }
      }
    }
  }
}

async function replantCrop(soil, crop) {
  let itemName = crop.includes('carrot') ? 'carrot' : crop.includes('potato') ? 'potato' : 'seeds';
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
