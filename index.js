const mineflayer = require('mineflayer');
const { pathfinder, Movements, goals: { GoalBlock, GoalNear } } = require('mineflayer-pathfinder');
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

// Error and disconnect handling
bot._client.on('error', err => log(`[Client Error] ${err.message}`));
bot._client.on('close', () => log(`[Client] Connection closed.`));

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

let mcData;

bot.once('spawn', () => {
  mcData = require('minecraft-data')(bot.version);
  const defaultMove = new Movements(bot, mcData);
  bot.pathfinder.setMovements(defaultMove);

  // Positions and areas
  const houseCenter = new Vec3(-1244, 72, -448);
  const houseSize = 11;

  const chestPos = new Vec3(-1243, 72, -450);
  const craftingTablePos = new Vec3(-1242, 72, -450);

  const farmMin = new Vec3(-1233, 71, -449);
  const farmMax = new Vec3(-1216, 71, -440);

  // Roaming inside house
  async function getRandomWalkablePoint() {
    const half = Math.floor(houseSize / 2);
    const candidates = [];

    for (let x = houseCenter.x - half; x <= houseCenter.x + half; x++) {
      for (let z = houseCenter.z - half; z <= houseCenter.z + half; z++) {
        for (let y = houseCenter.y - 1; y <= houseCenter.y + 5; y++) {
          const pos = new Vec3(x, y, z);
          const blockBelow = bot.blockAt(pos.offset(0, -1, 0));
          const blockAt = bot.blockAt(pos);
          const blockAbove = bot.blockAt(pos.offset(0, 1, 0));

          if (
            blockBelow && blockBelow.boundingBox === 'block' &&
            blockAt && blockAt.boundingBox === 'empty' &&
            blockAbove && blockAbove.boundingBox === 'empty'
          ) {
            candidates.push(pos);
          }
        }
      }
    }

    return candidates.length > 0
      ? candidates[Math.floor(Math.random() * candidates.length)]
      : houseCenter;
  }

  async function roamInsideHouse() {
    const target = await getRandomWalkablePoint();
    const goal = new GoalBlock(target.x, target.y, target.z);
    bot.pathfinder.setGoal(goal);
    log(`[Move] Roaming to (${goal.x}, ${goal.y}, ${goal.z})`);

    const onGoalReached = () => {
      log(`[Move] Reached (${goal.x}, ${goal.y}, ${goal.z}), roaming again soon...`);
      bot.pathfinder.setGoal(null);
      setTimeout(roamInsideHouse, 3000);
      bot.removeListener('goal_reached', onGoalReached);
    };

    bot.once('goal_reached', onGoalReached);
  }

  // Chest interaction helper
  async function getItem(name, amount) {
    const chest = bot.blockAt(chestPos);
    if (!chest) {
      log('[Chest] Chest not found.');
      return false;
    }
    const chestWindow = await bot.openContainer(chest);
    const item = chestWindow.containerItems().find(i => i.name.includes(name));
    if (!item) {
      log(`[Chest] No ${name} found in chest.`);
      chestWindow.close();
      return false;
    }

    try {
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
      log(`[Chest] Took ${amount}x ${name} from chest.`);
    } catch (err) {
      log(`[Chest] Error transferring ${name}: ${err.message}`);
    }
    chestWindow.close();
    return true;
  }

  // Craft bread if enough wheat
  async function craftBread() {
    const wheatCount = bot.inventory.count(mcData.itemsByName.wheat.id);
    if (wheatCount >= 3) {
      await bot.pathfinder.goto(new GoalBlock(craftingTablePos.x, craftingTablePos.y, craftingTablePos.z));
      const tableBlock = bot.blockAt(craftingTablePos);
      if (!tableBlock) {
        log('[Craft] Crafting table not found.');
        return;
      }
      const recipe = bot.recipesFor(mcData.itemsByName.bread.id, null, 1, tableBlock)[0];
      if (!recipe) {
        log('[Craft] No bread recipe found.');
        return;
      }
      try {
        await bot.craft(recipe, Math.floor(wheatCount / 3), tableBlock);
        log('[Craft] Crafted bread.');
      } catch (err) {
        log(`[Craft] Crafting failed: ${err.message}`);
      }
    }
  }

  // Farm logic: till, harvest, replant
  async function tillAndReplant() {
    for (let x = farmMin.x; x <= farmMax.x; x++) {
      for (let z = farmMin.z; z <= farmMax.z; z++) {
        const pos = new Vec3(x, 71, z);
        const block = bot.blockAt(pos);
        const above = bot.blockAt(pos.offset(0, 1, 0));
        if (!block) continue;

        if (block.name === 'dirt') {
          // Need hoe to till
          let hoe = bot.inventory.items().find(i => i.name.includes('hoe'));
          if (!hoe) {
            const gotHoe = await getItem('hoe', 1);
            if (!gotHoe) continue;
            hoe = bot.inventory.items().find(i => i.name.includes('hoe'));
          }
          await bot.equip(hoe, 'hand');
          await bot.pathfinder.goto(new GoalBlock(pos.x, pos.y, pos.z));
          try {
            await bot.activateBlock(block);
            log(`[Farm] Tilled dirt at ${pos}`);
          } catch (err) {
            log(`[Farm] Failed to till at ${pos}: ${err.message}`);
          }
        } else if (block.name === 'farmland') {
          if (!above) continue;

          if (above.name.includes('wheat')) {
            // Wheat crop
            const age = above.properties?.age;
            if (age === 7) {
              // Fully grown wheat, harvest
              try {
                await bot.dig(above);
                log(`[Farm] Harvested wheat at ${pos}`);

                // Replant seeds
                let seeds = bot.inventory.items().find(i => i.name.includes('seeds'));
                if (!seeds) {
                  const gotSeeds = await getItem('seeds', 5);
                  if (!gotSeeds) continue;
                  seeds = bot.inventory.items().find(i => i.name.includes('seeds'));
                }
                await bot.equip(seeds, 'hand');
                await bot.placeBlock(block, new Vec3(0, 1, 0));
                log(`[Farm] Replanted wheat at ${pos}`);
              } catch (err) {
                log(`[Farm] Failed wheat harvest/plant at ${pos}: ${err.message}`);
              }
            }
          } else if (above.name.includes('potatoes')) {
            const age = above.properties?.age;
            if (age === 7) {
              // Fully grown potatoes, harvest
              try {
                await bot.dig(above);
                log(`[Farm] Harvested potato at ${pos}`);

                // Replant potatoes
                let potato = bot.inventory.items().find(i => i.name.includes('potato'));
                if (!potato) {
                  const gotPotato = await getItem('potato', 5);
                  if (!gotPotato) continue;
                  potato = bot.inventory.items().find(i => i.name.includes('potato'));
                }
                await bot.equip(potato, 'hand');
                await bot.placeBlock(block, new Vec3(0, 1, 0));
                log(`[Farm] Replanted potato at ${pos}`);
              } catch (err) {
                log(`[Farm] Failed potato harvest/plant at ${pos}: ${err.message}`);
              }
            }
          }
        }
      }
    }
  }

  // Circular patrol around house center (6x6 area)
  let patrolIndex = 0;
  const patrolPoints = [
    new Vec3(houseCenter

