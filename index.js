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
let patrolIndex = 0;
let isEating = false;
let alreadyLoggedIn = false;
let routineRunning = false;

const chatAnnounceEnabled = config.chatAnnouncements?.enable ?? false;
const farmingMessage = config.chatAnnouncements?.farmingMessage || "Farming now!";

function log(msg) {
  const time = new Date().toISOString();
  const line = `[${time}] ${msg}`;
  console.log(line);
  try {
    fs.appendFileSync('logs.txt', line + '\n');
  } catch (e) {
    console.error('Failed to write log:', e);
  }
}

async function openDoorAt(pos) {
  const block = bot.blockAt(pos);
  if (!block || !block.name.includes('door')) return false;

  const isOpen = block.state?.open || block.properties?.open === 'true';
  if (!isOpen) {
    try {
      await bot.interact(block);
      log(`Opened door at ${pos.x}, ${pos.y}, ${pos.z}`);
      if (chatAnnounceEnabled) bot.chat('Opening door...');
      await new Promise(r => setTimeout(r, 1000));
      return true;
    } catch (err) {
      console.error('Error opening door:', err);
      return false;
    }
  }
  return true;
}

function createBot() {
  log('⏳ Creating bot...');
  bot = mineflayer.createBot({
    host: config.host,
    port: config.port,
    username: config.username || 'Bot',
    version: config.version || false,
    auth: 'offline',
  });

  bot.loadPlugin(pathfinder);

  bot.once('spawn', onBotReady);
  bot.on('error', err => console.error('❌ Bot error:', err));
  bot.on('kicked', reason => {
    log(`❌ Bot kicked: ${reason}`);
    cleanupAndReconnect();
  });
  bot.on('end', () => {
    log('❌ Bot disconnected.');
    cleanupAndReconnect();
  });

  bot.on('message', (msg) => {
    const text = msg.toString().toLowerCase();
    const password = config.password;
    if (alreadyLoggedIn) return;

    if (text.includes('register')) {
      bot.chat(`/register ${password} ${password}`);
      log('[Login] Registered');
      alreadyLoggedIn = true;
    } else if (text.includes('login')) {
      bot.chat(`/login ${password}`);
      log('[Login] Logged in');
      alreadyLoggedIn = true;
    }
  });
}

function cleanupAndReconnect() {
  if (!bot) return;
  bot.removeAllListeners();
  bot = null;
  sleeping = false;
  lastDay = -1;
  patrolIndex = 0;
  alreadyLoggedIn = false;
  routineRunning = false;
  setTimeout(createBot, 5000);
}

async function onBotReady() {
  log('🟢 Bot spawned.');
  mcData = mcDataLib(bot.version);
  defaultMove = new Movements(bot, mcData);
  defaultMove.canDig = false;
  defaultMove.allow1by1tallDoors = true;
  bot.pathfinder.setMovements(defaultMove);

  bot.on('physicsTick', eatWhenHungry);

  if (!routineRunning) {
    routineRunning = true;
    dailyRoutineLoop();
  }
}

async function dailyRoutineLoop() {
  if (sleeping) return;

  try {
    const time = bot.time?.dayTime ?? 0;
    const currentDay = Math.floor(bot.time.age / 24000);

    log(`DailyRoutine running - time: ${time}, day: ${currentDay}`);

    if (time >= 13000 && time <= 23458) {
      log('Time to go to bed...');
      await goToBed();
    } else if (currentDay !== lastDay) {
      lastDay = currentDay;
      if (currentDay % 2 === 0) {
        log('Even day: roaming');
        await roamLoop();
      } else {
        log('Odd day: farming');
        await openDoorAt(new Vec3(config.farmMin.x, config.farmMin.y, config.farmMin.z));
        await bot.pathfinder.goto(new GoalBlock(config.farmMin.x, config.farmMin.y, config.farmMin.z));

        if (chatAnnounceEnabled) bot.chat(farmingMessage);
        log('Starting to farm crops...');
        await farmCrops();
        log('Finished farming crops.');

        await craftBread();
        await storeExcessItems();

        await openDoorAt(new Vec3(config.walkCenter.x, config.walkCenter.y, config.walkCenter.z));
        await bot.pathfinder.goto(new GoalBlock(config.walkCenter.x, config.walkCenter.y, config.walkCenter.z));
      }
    }

  } catch (err) {
    console.error('Error in dailyRoutineLoop:', err);
  }

  setTimeout(dailyRoutineLoop, 5000);
}

let isRoaming = false;
async function roamLoop() {
  if (sleeping || isRoaming) return;
  isRoaming = true;

  const center = config.walkCenter;
  const offsetX = Math.floor(Math.random() * 11) - 5;
  const offsetZ = Math.floor(Math.random() * 11) - 5;
  const targetX = center.x + offsetX;
  const targetZ = center.z + offsetZ;
  const targetY = center.y;

  try {
    await openDoorAt(new Vec3(targetX, targetY, targetZ));
    await bot.pathfinder.goto(new GoalBlock(targetX, targetY, targetZ));
  } catch (err) {
    if (err.message?.includes("NoPath")) {
      console.warn('⚠️ RoamLoop: No path to goal. Retrying in 5 seconds...');
    } else {
      console.error('Error in roamLoop:', err);
    }
  } finally {
    isRoaming = false;
    setTimeout(roamLoop, 5000);
  }
}

function eatWhenHungry() {
  if (isEating || !bot || bot.food >= 18) return;
  const foodItem = bot.inventory.items().find(i => {
    const itemData = mcData.items[i.type];
    return itemData && itemData.food !== undefined;
  });
  if (foodItem) {
    isEating = true;
    bot.equip(foodItem, 'hand')
      .then(() => bot.consume())
      .catch(err => console.error('Error eating:', err))
      .finally(() => { isEating = false; });
  }
}

async function goToBed() {
  if (sleeping) return;
  const bed = bot.findBlock({ matching: block => block.name.endsWith('_bed'), maxDistance: 64 });
  if (!bed) {
    log('No bed found nearby.');
    return;
  }

  try {
    await bot.pathfinder.goto(new GoalBlock(bed.position.x, bed.position.y, bed.position.z));
    await bot.sleep(bed);
    sleeping = true;
    log('Bot is now sleeping.');
    if (chatAnnounceEnabled) bot.chat('Going to sleep...');
    bot.once('wake', () => {
      sleeping = false;
      log('Bot woke up.');
      if (chatAnnounceEnabled) bot.chat('Good morning!');
      dailyRoutineLoop();
    });
  } catch (err) {
    log('Error going to bed: ' + err.message);
  }
}

async function farmCrops() {
  const farmMin = new Vec3(config.farmMin.x, config.farmMin.y, config.farmMin.z);
  const farmMax = new Vec3(config.farmMax.x, config.farmMax.y, config.farmMax.z);

  for (let x = farmMin.x; x <= farmMax.x; x++) {
    for (let z = farmMin.z; z <= farmMax.z; z++) {
      const soil = bot.blockAt(new Vec3(x, farmMin.y, z));
      const crop = bot.blockAt(new Vec3(x, farmMin.y + 1, z));
      if (!soil || !crop || soil.name !== 'farmland') continue;
      if (['wheat', 'carrots', 'potatoes'].includes(crop.name) && crop.properties?.age == 7) {
        try {
          await bot.dig(crop);
          await replantCrop(soil, crop.name);
        } catch (err) {
          console.error('Error farming crops:', err);
        }
      }
    }
  }
}

async function replantCrop(soil, cropName) {
  let seedName = 'seeds';
  if (cropName.includes('potato')) seedName = 'potato';
  else if (cropName.includes('carrot')) seedName = 'carrot';

  let seedItem = bot.inventory.items().find(i => i.name.includes(seedName));
  if (!seedItem) return;

  await bot.equip(seedItem, 'hand');
  await bot.placeBlock(soil, new Vec3(0, 1, 0));
}

async function craftBread() {
  const wheatId = mcData.itemsByName.wheat.id;
  const wheatCount = bot.inventory.count(wheatId);
  if (wheatCount < 3) return;

  const craftingTable = bot.findBlock({ matching: block => block.name === 'crafting_table', maxDistance: 16 });
  if (!craftingTable) return;

  try {
    await openDoorAt(craftingTable.position);
    await bot.pathfinder.goto(new GoalBlock(craftingTable.position.x, craftingTable.position.y, craftingTable.position.z));
    const recipe = bot.recipesFor(mcData.itemsByName.bread.id, null, 1, craftingTable)[0];
    if (recipe) await bot.craft(recipe, Math.floor(wheatCount / 3), craftingTable);
  } catch (err) {
    console.error('Error crafting bread:', err);
  }
}

async function storeExcessItems() {
  const chest = bot.findBlock({ matching: block => block.name === 'chest', maxDistance: 16 });
  if (!chest) return;

  try {
    await openDoorAt(chest.position);
    await bot.pathfinder.goto(new GoalBlock(chest.position.x, chest.position.y, chest.position.z));
    const chestWindow = await bot.openContainer(chest);
    // Add logic to store items here if needed
    chestWindow.close();
  } catch (err) {
    console.error('Error accessing chest:', err);
  }
}

createBot();
