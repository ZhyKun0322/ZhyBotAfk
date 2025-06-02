const mineflayer = require('mineflayer');
const { pathfinder, Movements, goals: { GoalBlock } } = require('mineflayer-pathfinder');
const Vec3 = require('vec3');
const mcDataLib = require('minecraft-data');
const config = require('./config.json');

let bot;
let mcData;
let defaultMove;
let sleeping = false;
let lastDay = -1;
let patrolIndex = 0;
let isEating = false;

function createBot() {
  bot = mineflayer.createBot({
    host: config.host,
    port: config.port,
    username: config.username,
    version: config.version || false,
    auth: 'offline' // change if needed
  });

  bot.loadPlugin(pathfinder);

  // Event handlers
  bot.once('login', () => console.log('✅ Bot logged in'));
  bot.once('spawn', onBotReady);

  bot.on('error', err => console.error('❌ Bot error:', err));

  bot.on('kicked', reason => {
    console.log('❌ Bot was kicked:', reason);
    cleanupAndReconnect();
  });

  bot.on('end', () => {
    console.log('❌ Bot disconnected.');
    cleanupAndReconnect();
  });

  // Remove listeners and reconnect after 5 seconds
  function cleanupAndReconnect() {
    if (!bot) return;
    bot.removeAllListeners();
    bot = null;
    sleeping = false;
    lastDay = -1;
    patrolIndex = 0;
    setTimeout(createBot, 5000);
  }

  async function onBotReady() {
    mcData = mcDataLib(bot.version);
    defaultMove = new Movements(bot, mcData);
    defaultMove.canDig = false;
    bot.pathfinder.setMovements(defaultMove);
    sleeping = false;
    lastDay = -1;
    patrolIndex = 0;

    // Register physicsTick once per bot spawn
    bot.on('physicsTick', eatWhenHungry);

    dailyRoutineLoop();
    furnaceSmeltLoop();
  }

  // Main loops

  async function dailyRoutineLoop() {
    if (sleeping) return;

    try {
      const time = bot.time.timeOfDay;
      const currentDay = Math.floor(bot.time.age / 24000);

      if (time >= 13000 && time <= 23458) {
        await goToBed();
      } else if (currentDay !== lastDay) {
        lastDay = currentDay;
        if (currentDay % 2 === 0) {
          roamLoop();
        } else {
          await bot.pathfinder.goto(new GoalBlock(
            config.walkCenter.x, config.walkCenter.y, config.walkCenter.z
          ));
          await farmCrops();
          await craftBread();
          await storeExcessItems();
        }
      }
    } catch (err) {
      console.error('Error in dailyRoutineLoop:', err);
    }

    setTimeout(dailyRoutineLoop, 5000);
  }

  async function roamLoop() {
    if (sleeping) return;
    const center = new Vec3(config.walkCenter.x, config.walkCenter.y, config.walkCenter.z);
    const points = [
      center.offset(-3, 0, 0),
      center.offset(3, 0, 0),
      center.offset(0, 0, -3),
      center.offset(0, 0, 3)
    ];

    try {
      const goal = points[patrolIndex];
      patrolIndex = (patrolIndex + 1) % points.length;
      await bot.pathfinder.goto(new GoalBlock(goal.x, goal.y, goal.z));
    } catch (err) {
      console.error('Error in roamLoop:', err);
    }

    setTimeout(roamLoop, 5000);
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
    const bed = findBed();
    if (!bed) return;
    try {
      await bot.pathfinder.goto(new GoalBlock(bed.position.x, bed.position.y, bed.position.z));
      await bot.sleep(bed);
      sleeping = true;
      bot.once('wake', () => {
        sleeping = false;
        dailyRoutineLoop();
      });
    } catch (err) {
      console.error('Error going to bed:', err);
    }
  }

  function findBed() {
    return bot.findBlock({
      matching: block => block.name.endsWith('_bed'),
      maxDistance: 6,
      validate: block => isInArea(block.position, config.bedArea),
    });
  }

  function isInArea(pos, area) {
    return (
      pos.x >= area.min.x && pos.x <= area.max.x &&
      pos.y >= area.min.y && pos.y <= area.max.y &&
      pos.z >= area.min.z && pos.z <= area.max.z
    );
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

    const table = bot.blockAt(new Vec3(config.craftingTable.x, config.craftingTable.y, config.craftingTable.z));
    if (!table) return;
    try {
      await bot.pathfinder.goto(new GoalBlock(table.position.x, table.position.y, table.position.z));
      const recipe = bot.recipesFor(mcData.itemsByName.bread.id, null, 1, table)[0];
      if (recipe) {
        await bot.craft(recipe, Math.floor(wheatCount / 3), table);
      }
    } catch (err) {
      console.error('Error crafting bread:', err);
    }
  }

  async function storeExcessItems() {
    const chestBlock = bot.blockAt(new Vec3(config.chest.x, config.chest.y, config.chest.z));
    if (!chestBlock) return;

    try {
      const chestWindow = await bot.openContainer(chestBlock);
      const keepNames = ['bread', 'seeds', 'potato', 'carrot', 'carrot_on_a_stick', 'hoe'];

      for (const item of bot.inventory.items()) {
        if (keepNames.some(name => item.name.includes(name))) continue;
        await bot.transfer(item, chestWindow, item.count);
      }
      chestWindow.close();
    } catch (err) {
      console.error('Error storing items:', err);
    }
  }

  async function getItemFromChest(name, amount) {
    const chestBlock = bot.blockAt(new Vec3(config.chest.x, config.chest.y, config.chest.z));
    if (!chestBlock) return false;

    try {
      const chestWindow = await bot.openContainer(chestBlock);
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

  async function furnaceSmeltLoop() {
    try {
      await smeltItemsInFurnace();
    } catch (err) {
      console.error('Error in furnaceSmeltLoop:', err);
    }
    setTimeout(furnaceSmeltLoop, 60000);
  }

  async function smeltItemsInFurnace() {
    const furnaceBlock = bot.blockAt(new Vec3(config.furnace.x, config.furnace.y, config.furnace.z));
    if (!furnaceBlock) return;

    try {
      const furnaceWindow = await bot.openContainer(furnaceBlock);
      const fuelNames = ['coal', 'charcoal', 'log', 'planks'];
      const smeltableNames = ['raw_', 'ore'];

      const fuelSlot = furnaceWindow.slots[1];
      if (!fuelSlot) {
        const fuelItem = bot.inventory.items().find(i => fuelNames.some(f => i.name.includes(f)));
        if (fuelItem) {
          await furnaceWindow.deposit(fuelItem.type, null, fuelItem.count, 1);
        }
      }

      const inputSlot = furnaceWindow.slots[0];
      if (!inputSlot) {
        const smeltItem = bot.inventory.items().find(i => smeltableNames.some(s => i.name.includes(s)));
        if (smeltItem) {
          await furnaceWindow.deposit(smeltItem.type, null, smeltItem.count, 0);
        }
      }
      furnaceWindow.close();
    } catch (err) {
      console.error('Error smelting items:', err);
    }
  }
}

createBot();
