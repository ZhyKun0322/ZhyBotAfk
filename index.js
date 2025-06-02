// ... [unchanged requires and variables]

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
  bot.on('error', err => {
    console.error('❌ Bot error:', err);
    log(`❌ Bot error: ${err.message}`);
  });
  bot.on('kicked', reason => {
    console.log('❌ Bot kicked:', reason);
    log(`❌ Bot kicked: ${reason}`);
    cleanupAndReconnect();
  });
  bot.on('end', () => {
    console.log('❌ Bot disconnected.');
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
  log('🔁 Cleaning up and reconnecting...');
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
  log('🟢 Bot spawned and ready.');
  mcData = mcDataLib(bot.version);
  defaultMove = new Movements(bot, mcData);
  defaultMove.canDig = false;
  defaultMove.allow1by1tallDoors = true;
  bot.pathfinder.setMovements(defaultMove);

  bot.on('physicsTick', eatWhenHungry);
  dailyRoutineLoop();
}

async function dailyRoutineLoop() {
  if (sleeping) {
    log('🛏️ Skipping dailyRoutineLoop — bot is sleeping.');
    return;
  }

  try {
    const time = bot.time?.dayTime ?? 0;
    const currentDay = Math.floor(bot.time.age / 24000);

    log(`📆 Checking routine — Day ${currentDay}, Time: ${time}`);

    if (time >= 13000 && time <= 23458) {
      log('🌙 It is nighttime — attempting to sleep.');
      await goToBed();
    } else if (currentDay !== lastDay) {
      lastDay = currentDay;
      log(`🔁 New day routine started: Day ${currentDay}`);
      if (currentDay % 2 === 0) {
        log('🚶 Day is even — roaming.');
        await roamLoop();
      } else {
        log('🌾 Day is odd — starting farming routine.');
        await bot.pathfinder.goto(new GoalBlock(config.farmMin.x, config.farmMin.y, config.farmMin.z));
        if (chatAnnounceEnabled) bot.chat(farmingMessage);
        await farmCrops();
        await craftBread();
        await storeExcessItems();
        await bot.pathfinder.goto(new GoalBlock(config.walkCenter.x, config.walkCenter.y, config.walkCenter.z));
      }
    }
  } catch (err) {
    console.error('Error in dailyRoutineLoop:', err);
    log(`❗ Error in dailyRoutineLoop: ${err.message}`);
  }

  setTimeout(dailyRoutineLoop, 5000);
}

async function roamLoop() {
  if (sleeping) {
    log('🛏️ Skipping roamLoop — bot is sleeping.');
    return;
  }

  const center = config.walkCenter;

  const offsetX = Math.floor(Math.random() * 11) - 5;
  const offsetZ = Math.floor(Math.random() * 11) - 5;

  const targetX = center.x + offsetX;
  const targetZ = center.z + offsetZ;
  const targetY = center.y;

  log(`🚶 Roaming to (${targetX}, ${targetY}, ${targetZ})`);

  try {
    await bot.pathfinder.goto(new GoalBlock(targetX, targetY, targetZ));
  } catch (err) {
    if (err.message?.includes("NoPath")) {
      console.warn('⚠️ No path to goal in roamLoop. Skipping.');
      log('⚠️ No path found in roamLoop.');
    } else {
      console.error('Error in roamLoop:', err);
      log(`❗ Error in roamLoop: ${err.message}`);
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
    log(`🍗 Bot is eating: ${foodItem.name}`);
    isEating = true;
    bot.equip(foodItem, 'hand')
      .then(() => bot.consume())
      .catch(err => {
        console.error('Error eating:', err);
        log(`❗ Error eating: ${err.message}`);
      })
      .finally(() => { isEating = false; });
  }
}

async function goToBed() {
  if (sleeping) return;
  const bed = bot.findBlock({ matching: block => block.name.endsWith('_bed'), maxDistance: 64 });
  if (!bed) {
    log('🛏️ No bed found nearby.');
    return;
  }

  try {
    log(`🛌 Going to bed at ${bed.position}`);
    await bot.pathfinder.goto(new GoalBlock(bed.position.x, bed.position.y, bed.position.z));
    await bot.sleep(bed);
    sleeping = true;
    log('💤 Bot is now sleeping.');
    bot.once('wake', () => {
      sleeping = false;
      log('🌞 Bot woke up.');
      dailyRoutineLoop();
    });
  } catch (err) {
    console.error('Error going to bed:', err);
    log(`❗ Error going to bed: ${err.message}`);
  }
}

async function farmCrops() {
  log('🌱 Farming crops...');
  const farmMin = new Vec3(config.farmMin.x, config.farmMin.y, config.farmMin.z);
  const farmMax = new Vec3(config.farmMax.x, config.farmMax.y, config.farmMax.z);

  for (let x = farmMin.x; x <= farmMax.x; x++) {
    for (let z = farmMin.z; z <= farmMax.z; z++) {
      const soil = bot.blockAt(new Vec3(x, farmMin.y, z));
      const crop = bot.blockAt(new Vec3(x, farmMin.y + 1, z));
      if (!soil || !crop || soil.name !== 'farmland') continue;
      if (crop.properties?.age === 7) {
        try {
          log(`🌾 Harvesting crop at (${x}, ${farmMin.y + 1}, ${z})`);
          await bot.dig(crop);
          await replantCrop(soil, crop.name);
        } catch (err) {
          console.error('Error farming crops:', err);
          log(`❗ Error farming crop at (${x}, ${z}): ${err.message}`);
        }
      }
    }
  }
}

async function replantCrop(soil, cropName) {
  let seedName = 'seeds';
  if (cropName.includes('potato')) seedName = 'potato';
  else if (cropName.includes('carrot')) seedName = 'carrot';

  log(`🌱 Replanting ${seedName} at ${soil.position}`);

  let seedItem = bot.inventory.items().find(i => i.name.includes(seedName));
  if (!seedItem) {
    const gotSeed = await getItemFromChest(seedName, 3);
    if (!gotSeed) {
      log(`❌ Could not find ${seedName} to replant.`);
      return;
    }
    seedItem = bot.inventory.items().find(i => i.name.includes(seedName));
  }

  if (seedItem) {
    await bot.equip(seedItem, 'hand');
    await bot.placeBlock(soil, new Vec3(0, 1, 0));
    log(`✅ Replanted ${seedName}.`);
  }
}

async function craftBread() {
  const wheatId = mcData.itemsByName.wheat.id;
  const wheatCount = bot.inventory.count(wheatId);
  if (wheatCount < 3) return;

  const craftingTable = bot.findBlock({ matching: block => block.name === 'crafting_table', maxDistance: 16 });
  if (!craftingTable) {
    log('❌ No crafting table found nearby.');
    return;
  }

  try {
    log('🍞 Crafting bread...');
    await bot.pathfinder.goto(new GoalBlock(craftingTable.position.x, craftingTable.position.y, craftingTable.position.z));
    const recipe = bot.recipesFor(mcData.itemsByName.bread.id, null, 1, craftingTable)[0];
    if (recipe) {
      await bot.craft(recipe, Math.floor(wheatCount / 3), craftingTable);
      log(`✅ Crafted ${Math.floor(wheatCount / 3)} bread.`);
    }
  } catch (err) {
    console.error('Error crafting bread:', err);
    log(`❗ Error crafting bread: ${err.message}`);
  }
}

async function storeExcessItems() {
  const chest = bot.findBlock({ matching: block => block.name === 'chest', maxDistance: 16 });
  if (!chest) {
    log('❌ No chest found nearby to store items.');
    return;
  }

  try {
    log('📦 Storing excess items...');
    const chestWindow = await bot.openContainer(chest);
    // (You can add your code here to transfer items to chest)
    chestWindow.close();
    log('✅ Chest closed after storing.');
  } catch (err) {
    console.error('Error storing excess items:', err);
    log(`❗ Error storing items: ${err.message}`);
  }
}

async function getItemFromChest(name, amount) {
  const chest = bot.findBlock({ matching: block => block.name === 'chest', maxDistance: 16 });
  if (!chest) {
    log('❌ No chest found to get item from.');
    return false;
  }

  try {
    log(`📤 Trying to get ${amount} ${name} from chest...`);
    const chestWindow = await bot.openContainer(chest);
    const item = chestWindow.containerItems().find(i => i.name.includes(name));
    if (!item) {
      log(`❌ No ${name} found in chest.`);
      chestWindow.close();
      return false;
    }
    await bot.transfer(item, bot.inventory, amount);
    chestWindow.close();
    log(`✅ Retrieved ${amount} ${name} from chest.`);
    return true;
  } catch (err) {
    console.error('Error getting item from chest:', err);
    log(`❗ Error getting item from chest: ${err.message}`);
    return false;
  }
}

createBot();
