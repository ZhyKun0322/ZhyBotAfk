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

const chatAnnounceEnabled = config.chatAnnouncements?.enable ?? false;
const farmingMessage = config.chatAnnouncements?.farmingMessage || "Farming now!";

function createBot() {
  console.log('⏳ Creating bot...');
  bot = mineflayer.createBot({
    host: config.host,
    port: config.port,
    username: config.username || 'Bot',
    version: config.version || false,
    auth: 'offline'
  });

  bot.loadPlugin(pathfinder);

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
  setTimeout(createBot, 5000);
}

function log(msg) {
  const time = new Date().toISOString();
  const line = `[${time}] ${msg}`;
  console.log(line);
  fs.appendFileSync('logs.txt', line + '\n');
}

async function onBotReady() {
  console.log('🟢 Bot spawned.');
  mcData = mcDataLib(bot.version);
  defaultMove = new Movements(bot, mcData);
  defaultMove.canDig = false;
  defaultMove.allow1by1tallDoors = true;
  bot.pathfinder.setMovements(defaultMove);

  bot.on('physicsTick', eatWhenHungry);
  dailyRoutineLoop();
}

async function openDoorAt(pos) {
  // Removed the call to bot.world.isLoaded because it doesn't exist
  console.log('⏳ Waiting for chunk to load for door...');
  await bot.waitForChunksToLoad();

  // Try exact door block first
  let doorBlock = bot.blockAt(new Vec3(pos.x, pos.y, pos.z));

  // If not door block there, search nearby within 3 blocks radius
  if (!doorBlock || !doorBlock.name.includes('door')) {
    doorBlock = bot.findBlock({
      matching: b => b.name.includes('door'),
      maxDistance: 3,
      point: new Vec3(pos.x, pos.y, pos.z)
    });
  }

  if (!doorBlock || !doorBlock.name.includes('door')) {
    console.log(`🚪 Door not found at (${pos.x}, ${pos.y}, ${pos.z})`);
    return;
  }

  if (!doorBlock.properties.open) {
    try {
      await bot.activateBlock(doorBlock);
      log(`Opened door at ${doorBlock.position.x},${doorBlock.position.y},${doorBlock.position.z}`);
    } catch (err) {
      console.error('Failed to open door:', err);
      return;
    }
  }

  let passedThrough = false;
  for (let i = 0; i < 40; i++) {
    const dist = bot.entity.position.distanceTo(doorBlock.position);
    if (dist < 1.5) {
      passedThrough = true;
      break;
    }
    await bot.waitForTicks(5);
  }

  const doorBlockNow = bot.blockAt(doorBlock.position);
  if (passedThrough && doorBlockNow?.properties.open) {
    try {
      await bot.activateBlock(doorBlockNow);
      log(`Closed door at ${doorBlockNow.position.x},${doorBlockNow.position.y},${doorBlockNow.position.z}`);
    } catch (err) {
      console.error('Failed to close door:', err);
    }
  }
}

async function dailyRoutineLoop() {
  if (sleeping) return;

  try {
    const time = bot.time?.dayTime ?? 0;
    const currentDay = Math.floor(bot.time.age / 24000);

    if (time >= 13000 && time <= 23458) {
      await goToBed();
    } else if (currentDay !== lastDay) {
      lastDay = currentDay;
      if (currentDay % 2 === 0) {
        await roamLoop();
      } else {
        await openDoorAt(config.door);
        await bot.pathfinder.goto(new GoalBlock(config.farmMin.x, config.farmMin.y, config.farmMin.z));

        if (chatAnnounceEnabled) bot.chat(farmingMessage);
        await farmCrops();
        await craftBread();
        await storeExcessItems();

        // ✅ Go back inside after farming
        await openDoorAt(config.door);
        await bot.pathfinder.goto(new GoalBlock(config.walkCenter.x, config.walkCenter.y, config.walkCenter.z));
      }
    }
  } catch (err) {
    console.error('Error in dailyRoutineLoop:', err);
  }

  setTimeout(dailyRoutineLoop, 5000);
}

async function roamLoop() {
  if (sleeping) return;

  const center = config.walkCenter;

  const offsetX = Math.floor(Math.random() * 11) - 5;
  const offsetZ = Math.floor(Math.random() * 11) - 5;

  const targetX = center.x + offsetX;
  const targetZ = center.z + offsetZ;
  const targetY = center.y;

  try {
    await openDoorAt(config.door);
    await bot.pathfinder.goto(new GoalBlock(targetX, targetY, targetZ));
  } catch (err) {
    if (err.message?.includes("NoPath")) {
      console.warn('⚠️ No path to goal in roamLoop. Skipping.');
    } else {
      console.error('Error in roamLoop:', err);
    }
  } finally {
    setTimeout(roamLoop, 5000);
  }
}

function eatWhenHungry() {
  if (isEating || bot.food >= 18) return;

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
  if (!bed) return console.log('No bed found nearby.');

  try {
    await openDoorAt(config.door);
    await bot.pathfinder.goto(new GoalBlock(bed.position.x, bed.position.y, bed.position.z));
    await bot.sleep(bed);
    sleeping = true;
    console.log('Bot is now sleeping.');
    bot.once('wake', () => {
      sleeping = false;
      dailyRoutineLoop();
    });
  } catch (err) {
    console.error('Error going to bed:', err);
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
      if (crop.properties?.age === 7) {
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
  if (!seedItem) {
    const gotSeed = await getItemFromChest(seedName, 3);
    if (!gotSeed) return;
    seedItem = bot.inventory.items().find(i => i.name.includes(seedName));
  }

  if (seedItem) {
    await bot.equip(seedItem, 'hand');
    await bot.placeBlock(soil, new Vec3(0, 1, 0));
  }
}

async function craftBread() {
  const wheatId = mcData.itemsByName.wheat.id;
  const wheatCount = bot.inventory.count(wheatId);
  if (wheatCount < 3) return;

  const craftingTable = bot.findBlock({ matching: block => block.name === 'crafting_table', maxDistance: 16 });
  if (!craftingTable) return console.log('No crafting table found nearby.');

  try {
    await openDoorAt(config.door);
    await bot.pathfinder.goto(new GoalBlock(craftingTable.position.x, craftingTable.position.y, craftingTable.position.z));
    const recipe = bot.recipesFor(mcData.itemsByName.bread.id, null, 1, craftingTable)[0];
    if (recipe) {
      await bot.craft(recipe, Math.floor(wheatCount / 3), craftingTable);
    }
  } catch (err) {
    console.error('Error crafting bread:', err);
  }
}

async function storeExcessItems() {
  const chest = bot.findBlock({ matching: block => block.name === 'chest', maxDistance: 16 });
  if (!chest) return console.log('No chest found nearby.');

  try {
    await openDoorAt(config.door);
    const chestWindow = await bot.openContainer(chest);
    // (You can add your code here to transfer items to chest)
    chestWindow.close();
  } catch (err) {
    console.error('Error storing excess items:', err);
  }
}

async function getItemFromChest(name, amount) {
  const chest = bot.findBlock({ matching: block => block.name === 'chest', maxDistance: 16 });
  if (!chest) return false;

  try {
    await openDoorAt(config.door);
    const chestWindow = await bot.openContainer(chest);
    const item = chestWindow.containerItems().find(i => i.name.includes(name));
    if (!item) {
      chestWindow.close();
      return false;
    }
    await bot.transfer(item, bot.inventory, amount);
    chestWindow.close();
    return true;
  } catch (err) {
    console.error('Error getting item from chest:', err);
    return false;
  }
}

createBot();
