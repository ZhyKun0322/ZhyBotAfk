const mineflayer = require('mineflayer');
const { pathfinder, Movements, goals: { GoalBlock } } = require('mineflayer-pathfinder');
const Vec3 = require('vec3');
const mcDataLib = require('minecraft-data');
const config = require('./config.json');

const bot = mineflayer.createBot({
  host: config.host,
  port: config.port,
  username: config.username,
  version: config.version || false,
  // If you want to use loginCode for cracked servers, use this:
  // auth: config.loginCode ? 'mojang' : undefined, // (or your login logic)
  // password: config.loginCode || undefined,
});

bot.loadPlugin(pathfinder);

let mcData;
let defaultMove;

const houseCenter = new Vec3(config.houseCenter.x, config.houseCenter.y, config.houseCenter.z);
const chestPos = new Vec3(config.chestPos.x, config.chestPos.y, config.chestPos.z);
const furnacePos = new Vec3(config.furnacePos.x, config.furnacePos.y, config.furnacePos.z);
const craftingTablePos = new Vec3(config.craftingTablePos.x, config.craftingTablePos.y, config.craftingTablePos.z);

const bedArea = {
  min: new Vec3(config.bedArea.min.x, config.bedArea.min.y, config.bedArea.min.z),
  max: new Vec3(config.bedArea.max.x, config.bedArea.max.y, config.bedArea.max.z),
};

const farmMin = new Vec3(config.farmMin.x, config.farmMin.y, config.farmMin.z);
const farmMax = new Vec3(config.farmMax.x, config.farmMax.y, config.farmMax.z);

const patrolPoints = config.patrolPoints.map(p => new Vec3(p.x, p.y, p.z));

let patrolIndex = 0;
let sleeping = false;
let lastDay = -1;

bot.once('spawn', () => {
  mcData = mcDataLib(bot.version);
  defaultMove = new Movements(bot, mcData);
  defaultMove.canDig = false;
  bot.pathfinder.setMovements(defaultMove);
  bot.on('physicsTick', eatWhenHungry);
  dailyRoutineLoop();
  furnaceSmeltLoop();
});

function getCurrentDay() {
  return Math.floor(bot.time.age / 24000);
}

// --- Day/Night Behavior Loop ---
async function dailyRoutineLoop() {
  if (sleeping) return;
  const time = bot.time.timeOfDay;
  const currentDay = getCurrentDay();

  if (time >= 13000 && time <= 23458) {
    await goToBed();
  } else if (currentDay !== lastDay) {
    lastDay = currentDay;
    if (currentDay % 2 === 0) {
      roamLoop();
    } else {
      await bot.pathfinder.goto(new GoalBlock(houseCenter.x, houseCenter.y, houseCenter.z));
      await farmCrops();
      await craftBread();
      await storeExcessItems();
    }
  }

  setTimeout(dailyRoutineLoop, 5000);
}

// --- Roaming ---
async function roamLoop() {
  if (sleeping) return;
  try {
    const goal = patrolPoints[patrolIndex];
    patrolIndex = (patrolIndex + 1) % patrolPoints.length;
    await bot.pathfinder.goto(new GoalBlock(goal.x, goal.y, goal.z));
  } catch {}
  setTimeout(roamLoop, 5000);
}

// --- Eating ---
let isEating = false;
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
      .catch(() => {})
      .finally(() => { isEating = false; });
  }
}

// --- Sleep at night ---
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
  } catch {}
}

function findBed() {
  return bot.findBlock({
    matching: block => block.name.endsWith('_bed'),
    maxDistance: 6,
    validate: block => isInArea(block.position, bedArea),
  });
}

function isInArea(pos, area) {
  return (
    pos.x >= area.min.x && pos.x <= area.max.x &&
    pos.y >= area.min.y && pos.y <= area.max.y &&
    pos.z >= area.min.z && pos.z <= area.max.z
  );
}

// --- Farming ---
async function farmCrops() {
  for (let x = farmMin.x; x <= farmMax.x; x++) {
    for (let z = farmMin.z; z <= farmMax.z; z++) {
      const soil = bot.blockAt(new Vec3(x, 71, z));
      const crop = bot.blockAt(new Vec3(x, 72, z));
      if (!soil || !crop || soil.name !== 'farmland') continue;
      if (crop.properties?.age === 7) {
        try {
          await bot.dig(crop);
          await replantCrop(soil, crop.name);
        } catch {}
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
  await bot.pathfinder.goto(new GoalBlock(craftingTablePos.x, craftingTablePos.y, craftingTablePos.z));
  const table = bot.blockAt(craftingTablePos);
  if (!table) return;
  const recipe = bot.recipesFor(mcData.itemsByName.bread.id, null, 1, table)[0];
  if (!recipe) return;
  try {
    await bot.craft(recipe, Math.floor(wheatCount / 3), table);
  } catch {}
}

// --- Chest ---
async function storeExcessItems() {
  const chestBlock = bot.blockAt(chestPos);
  if (!chestBlock) return;
  const chestWindow = await bot.openContainer(chestBlock);
  const keepNames = ['bread', 'seeds', 'potato', 'carrot', 'carrot_on_a_stick', 'hoe'];
  for (const item of bot.inventory.items()) {
    if (keepNames.some(name => item.name.includes(name))) continue;
    try {
      await bot.transfer(item, chestWindow, item.count);
    } catch {}
  }
  chestWindow.close();
}

async function getItemFromChest(name, amount) {
  const chestBlock = bot.blockAt(chestPos);
  if (!chestBlock) return false;
  const chestWindow = await bot.openContainer(chestBlock);
  const item = chestWindow.containerItems().find(i => i.name.includes(name));
  if (!item) {
    chestWindow.close();
    return false;
  }
  try {
    await bot.transfer(item, bot.inventory, amount);
    chestWindow.close();
    return true;
  } catch {
    chestWindow.close();
    return false;
  }
}

// --- Furnace ---
async function furnaceSmeltLoop() {
  try {
    await smeltItemsInFurnace();
  } catch {}
  setTimeout(furnaceSmeltLoop, 60000);
}

async function smeltItemsInFurnace() {
  const furnaceBlock = bot.blockAt(furnacePos);
  if (!furnaceBlock) return;
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
                                            }
