const mineflayer = require('mineflayer');
const { pathfinder, Movements, goals: { GoalBlock } } = require('mineflayer-pathfinder');
const fs = require('fs');
const Vec3 = require('vec3');
const config = require('./config.json');

const bot = mineflayer.createBot({
  host: config.host,
  port: config.port,
  username: config.username,
  version: config.version || false,
});

bot.loadPlugin(pathfinder);

// Logging utility
function log(msg) {
  const time = new Date().toISOString();
  const message = `[${time}] ${msg}`;
  console.log(message);
  fs.appendFileSync('logs.txt', message + '\n');
}

// Auto register/login
bot.on('message', (jsonMsg) => {
  const message = jsonMsg.toString().toLowerCase();
  const password = config.loginCode;
  if (message.includes('register') || message.includes('not registered')) {
    bot.chat(`/register ${password} ${password}`);
    log(`[Login] Registered.`);
  } else if (message.includes('login') || message.includes('logged out')) {
    bot.chat(`/login ${password}`);
    log(`[Login] Logged in.`);
  }
});

// Globals
let mcData;
const houseCenter = new Vec3(-1244, 72, -448);
const houseSize = 11;
const chestPos = new Vec3(-1243, 72, -450);
const craftingTablePos = new Vec3(-1242, 72, -450);
const bedArea = { min: new Vec3(-1246, 72, -450), max: new Vec3(-1241, 72, -445) };
const farmMin = new Vec3(-1233, 71, -449);
const farmMax = new Vec3(-1216, 71, -440);
const doorPos = new Vec3(-1247, 72, -453); // your real door

// Patrol points (6x6 circle)
const patrolPoints = [];
for (let dx = -3; dx <= 3; dx++) {
  for (let dz = -3; dz <= 3; dz++) {
    if (Math.abs(dx) === 3 || Math.abs(dz) === 3) {
      patrolPoints.push(houseCenter.offset(dx, 0, dz));
    }
  }
}
let patrolIndex = 0;

bot.once('spawn', () => {
  mcData = require('minecraft-data')(bot.version);
  const defaultMove = new Movements(bot, mcData);
  defaultMove.canDig = false; // prevent breaking blocks
  bot.pathfinder.setMovements(defaultMove);
  log(`[Bot] Spawned.`);

  bot.on('physicTick', eatWhenHungry);
  roamLoop();
  setInterval(farmAndCraftLoop, 30000);
});

// Eat if hungry
function eatWhenHungry() {
  if (bot.food < 18) {
    const food = bot.inventory.items().find(i => i.name.includes('bread') || i.name.includes('potato'));
    if (food) {
      bot.equip(food, 'hand').then(() => bot.consume()).then(() => log('[Eat] Ate food.'));
    }
  }
}

// Open door if needed
async function openDoorIfClosed() {
  const doorBlock = bot.blockAt(doorPos);
  if (!doorBlock || !doorBlock.name.includes('door')) return;

  const isClosed = doorBlock.metadata < 4;
  if (isClosed) {
    try {
      await bot.activateBlock(doorBlock);
      await bot.waitForTicks(10);
      log(`[Door] Opened the door at ${doorPos}`);
    } catch (err) {
      log(`[Door] Failed to open: ${err.message}`);
    }
  }
}

// Close door if open
async function closeDoorIfOpen() {
  const doorBlock = bot.blockAt(doorPos);
  if (!doorBlock || !doorBlock.name.includes('door')) return;

  const isOpen = doorBlock.metadata >= 4;
  if (isOpen) {
    try {
      await bot.activateBlock(doorBlock);
      await bot.waitForTicks(10);
      log(`[Door] Closed the door at ${doorPos}`);
    } catch (err) {
      log(`[Door] Failed to close: ${err.message}`);
    }
  }
}

// Roaming + patrol loop
async function roamLoop() {
  const time = bot.time.timeOfDay;
  if (time >= 13000 && time <= 23458) {
    await goToBed();
  } else {
    try {
      await openDoorIfClosed();
      const goal = patrolPoints[patrolIndex];
      patrolIndex = (patrolIndex + 1) % patrolPoints.length;
      await bot.pathfinder.goto(new GoalBlock(goal.x, goal.y, goal.z));
      log(`[Patrol] Walking to ${goal}`);
      await closeDoorIfOpen(); // Close door after moving
    } catch (err) {
      log(`[Path] Failed to walk: ${err.message}`);
    }
    setTimeout(roamLoop, 5000);
  }
}

// Sleep in bed inside house
async function goToBed() {
  const bed = bot.findBlock({
    matching: block => mcData.blocksByName.bed && block.name.includes('bed'),
    maxDistance: 6,
  });
  if (bed) {
    try {
      await bot.pathfinder.goto(new GoalBlock(bed.position.x, bed.position.y, bed.position.z));
      await bot.sleep(bed);
      log('[Sleep] Sleeping...');
      bot.once('wake', () => {
        log('[Sleep] Woke up.');
        roamLoop();
      });
    } catch (err) {
      log(`[Sleep] Failed to sleep: ${err.message}`);
      setTimeout(roamLoop, 3000);
    }
  } else {
    log('[Sleep] No bed found inside house.');
    setTimeout(roamLoop, 3000);
  }
}

// Open chest and take item
async function getItem(name, amount) {
  const chest = bot.blockAt(chestPos);
  if (!chest) return false;
  const chestWindow = await bot.openContainer(chest);
  const item = chestWindow.containerItems().find(i => i.name.includes(name));
  if (!item) {
    chestWindow.close();
    return false;
  }
  await bot.transfer({
    window: chestWindow,
    itemType: item.type,
    metadata: 0,
    count: amount,
    sourceStart: chestWindow.containerSlotStart,
    sourceEnd: chestWindow.containerSlotEnd,
    destStart: 36,
    destEnd: 45,
  });
  chestWindow.close();
  return true;
}

// Craft bread
async function craftBread() {
  const wheatCount = bot.inventory.count(mcData.itemsByName.wheat.id);
  if (wheatCount < 3) return;
  await bot.pathfinder.goto(new GoalBlock(craftingTablePos.x, craftingTablePos.y, craftingTablePos.z));
  const table = bot.blockAt(craftingTablePos);
  const recipe = bot.recipesFor(mcData.itemsByName.bread.id, null, 1, table)[0];
  if (recipe) {
    await bot.craft(recipe, Math.floor(wheatCount / 3), table);
    log('[Craft] Crafted bread.');
  }
}

// Farm loop
async function farmAndCraftLoop() {
  for (let x = farmMin.x; x <= farmMax.x; x++) {
    for (let z = farmMin.z; z <= farmMax.z; z++) {
      const pos = new Vec3(x, 71, z);
      const soil = bot.blockAt(pos);
      const crop = bot.blockAt(pos.offset(0, 1, 0));

      if (!soil || !crop) continue;
      if (soil.name === 'farmland') {
        const age = crop?.properties?.age;
        if (age === 7) {
          try {
            await bot.dig(crop);
            log(`[Farm] Harvested at ${pos}`);
            let seedName = crop.name.includes('wheat') ? 'seeds' : 'potato';
            let item = bot.inventory.items().find(i => i.name.includes(seedName));
            if (!item) await getItem(seedName, 3);
            item = bot.inventory.items().find(i => i.name.includes(seedName));
            await bot.equip(item, 'hand');
            await bot.placeBlock(soil, new Vec3(0, 1, 0));
            log(`[Farm] Replanted ${seedName} at ${pos}`);
          } catch (err) {
            log(`[Farm] Error at ${pos}: ${err.message}`);
          }
        }
      }
    }
  }

  await craftBread();
}
