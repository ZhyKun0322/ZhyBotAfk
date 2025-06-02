
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

const chatAnnounceEnabled = config.chatAnnouncements?.enable ?? false;
const farmingMessage = config.chatAnnouncements?.farmingMessage || "Farming now!";

async function openDoorAt(pos) {
  const doorBlock = bot.blockAt(new Vec3(pos.x, pos.y, pos.z));
  if (doorBlock && doorBlock.name.includes('door') && !doorBlock.properties.open) {
    try {
      await bot.activateBlock(doorBlock);
      console.log(`Opened door at ${pos.x},${pos.y},${pos.z}`);
    } catch (err) {
      console.error('Failed to open door:', err);
    }
  }
}

function createBot() {
  console.log('â³ Creating bot...');
  bot = mineflayer.createBot({
    host: config.host,
    port: config.port,
    username: config.username || 'Bot',
    version: config.version || false,
    auth: config.onlineMode ? 'microsoft' : 'offline'
  });

  bot.loadPlugin(pathfinder);

  bot.once('login', () => {
    console.log(`âœ… Bot logged in (${config.onlineMode ? 'online' : 'offline'} mode)`);
  });

  bot.once('spawn', onBotReady);

  bot.on('error', err => {
    console.error('âŒ Bot error:', err);
  });

  bot.on('kicked', reason => {
    console.log('âŒ Bot kicked:', reason);
    reconnectBot();
  });

  bot.on('end', () => {
    console.log('âŒ Bot disconnected.');
    reconnectBot();
  });

  function reconnectBot() {
    if (!bot) return;
    bot.removeAllListeners();
    bot = null;
    sleeping = false;
    lastDay = -1;
    patrolIndex = 0;
    setTimeout(createBot, 5000);
  }

  async function onBotReady() {
    console.log('ðŸŸ¢ Bot spawned.');
    mcData = mcDataLib(bot.version);
    defaultMove = new Movements(bot, mcData);
    defaultMove.canDig = false;
    defaultMove.allow1by1tallDoors = true;
    bot.pathfinder.setMovements(defaultMove);
    bot.on('physicsTick', eatWhenHungry);
    routineLoop();
    smeltLoop();
  }

  async function routineLoop() {
    if (sleeping) return;
    try {
      const time = bot.time?.dayTime ?? 0;
      const day = Math.floor(bot.time.age / 24000);
      if (time >= 13000 && time <= 23458) {
        await goToBed();
      } else if (day !== lastDay) {
        lastDay = day;
        if (day % 2 === 0) await roam();
        else {
          await openDoorAt(config.door);
          await bot.pathfinder.goto(new GoalBlock(config.walkCenter.x, config.walkCenter.y, config.walkCenter.z));
          if (chatAnnounceEnabled) bot.chat(farmingMessage);
          await farmCrops();
          await craftBread();
          await storeItems();
        }
      }
    } catch (err) {
      console.error('Error in routine:', err);
    }
    setTimeout(routineLoop, 5000);
  }

  async function roam() {
    if (sleeping) return;
    const center = new Vec3(config.walkCenter.x, config.walkCenter.y, config.walkCenter.z);
    const radius = 5;
    const points = [
      center.offset(-radius, 0, 0),
      center.offset(radius, 0, 0),
      center.offset(0, 0, -radius),
      center.offset(0, 0, radius)
    ];
    try {
      const goal = points[patrolIndex];
      patrolIndex = (patrolIndex + 1) % points.length;
      await openDoorAt(config.door);
      await bot.pathfinder.goto(new GoalBlock(goal.x, goal.y, goal.z));
    } catch (err) {
      console.error('Roam error:', err);
    }
    setTimeout(roam, 5000);
  }

  function eatWhenHungry() {
    if (isEating || bot.food >= 18) return;
    const foodItem = bot.inventory.items().find(i => mcData.items[i.type]?.food !== undefined);
    if (foodItem) {
      isEating = true;
      bot.equip(foodItem, 'hand')
        .then(() => bot.consume())
        .catch(err => console.error('Eat error:', err))
        .finally(() => { isEating = false; });
    }
  }

  async function goToBed() {
    if (sleeping) return;
    const bed = bot.findBlock({ matching: b => b.name.endsWith('_bed'), maxDistance: 16 });
    if (!bed) return console.log('No bed found.');
    try {
      await openDoorAt(config.door);
      await bot.pathfinder.goto(new GoalBlock(bed.position.x, bed.position.y, bed.position.z));
      await bot.sleep(bed);
      sleeping = true;
      console.log('Sleeping...');
      bot.once('wake', () => {
        sleeping = false;
        routineLoop();
      });
    } catch (err) {
      console.error('Sleep error:', err);
    }
  }

  async function farmCrops() {
    const min = new Vec3(config.farmMin.x, config.farmMin.y, config.farmMin.z);
    const max = new Vec3(config.farmMax.x, config.farmMax.y, config.farmMax.z);
    for (let x = min.x; x <= max.x; x++) {
      for (let z = min.z; z <= max.z; z++) {
        const soil = bot.blockAt(new Vec3(x, min.y, z));
        const crop = bot.blockAt(new Vec3(x, min.y + 1, z));
        if (!soil || !crop || soil.name !== 'farmland') continue;
        if (crop.properties?.age === 7) {
          try {
            await bot.dig(crop);
            await replant(soil, crop.name);
          } catch (err) {
            console.error('Farm error:', err);
          }
        }
      }
    }
  }

  async function replant(soil, cropName) {
    let seed = 'seeds';
    if (cropName.includes('potato')) seed = 'potato';
    else if (cropName.includes('carrot')) seed = 'carrot';

    let item = bot.inventory.items().find(i => i.name.includes(seed));
    if (!item) {
      const success = await getItem(seed, 3);
      if (!success) return;
      item = bot.inventory.items().find(i => i.name.includes(seed));
    }
    if (item) {
      await bot.equip(item, 'hand');
      await bot.placeBlock(soil, new Vec3(0, 1, 0));
    }
  }

  async function craftBread() {
    const wheatId = mcData.itemsByName.wheat.id;
    const count = bot.inventory.count(wheatId);
    if (count < 3) return;
    const table = bot.findBlock({ matching: b => b.name === 'crafting_table', maxDistance: 16 });
    if (!table) return;
    try {
      await openDoorAt(config.door);
      await bot.pathfinder.goto(new GoalBlock(table.position.x, table.position.y, table.position.z));
      const recipe = bot.recipesFor(mcData.itemsByName.bread.id, null, 1, table)[0];
      if (recipe) await bot.craft(recipe, Math.floor(count / 3), table);
    } catch (err) {
      console.error('Craft error:', err);
    }
  }

  async function storeItems() {
    const chest = bot.findBlock({ matching: b => b.name === 'chest', maxDistance: 16 });
    if (!chest) return;
    try {
      await openDoorAt(config.door);
      const win = await bot.openContainer(chest);
      const keep = ['bread', 'seeds', 'potato', 'carrot', 'hoe'];
      for (const item of bot.inventory.items()) {
        if (keep.some(n => item.name.includes(n))) continue;
        await bot.transfer(item, win, item.count);
      }
      win.close();
    } catch (err) {
      console.error('Store error:', err);
    }
  }

  async function getItem(name, amount) {
    const chest = bot.findBlock({ matching: b => b.name === 'chest', maxDistance: 16 });
    if (!chest) return false;
    try {
      await openDoorAt(config.door);
      const win = await bot.openContainer(chest);
      const item = win.containerItems().find(i => i.name.includes(name));
      if (!item) return false;
      await bot.transfer(item, bot.inventory, amount);
      win.close();
      return true;
    } catch (err) {
      console.error('Get item error:', err);
      return false;
    }
  }

  async function smeltLoop() {
    try {
      await smeltItems();
    } catch (err) {
      console.error('Smelt loop error:', err);
    }
    setTimeout(smeltLoop, 60000);
  }

  async function smeltItems() {
    const furnace = bot.findBlock({ matching: b => b.name === 'furnace', maxDistance: 16 });
    if (!furnace) return;
    try {
      await openDoorAt(config.door);
      const win = await bot.openContainer(furnace);
      const fuels = ['coal', 'charcoal', 'log', 'planks'];
      const ores = ['raw_', 'ore'];
      const fuel = bot.inventory.items().find(i => fuels.some(f => i.name.includes(f)));
      const smelt = bot.inventory.items().find(i => ores.some(f => i.name.includes(f)));
      if (fuel) await win.deposit(fuel.type, null, fuel.count, 1);
      if (smelt) await win.deposit(smelt.type, null, smelt.count, 0);
      win.close();
    } catch (err) {
      console.error('Smelt error:', err);
    }
  }
}

createBot();
