const mineflayer = require('mineflayer');
const { pathfinder, Movements, goals: { GoalNear } } = require('mineflayer-pathfinder');
const Vec3 = require('vec3');
const mcDataLoader = require('minecraft-data');
const fs = require('fs');
const config = require('./config.json');

let bot, mcData, defaultMove;
let sleeping = false;
let isRunning = true;
let isEating = false;
let alreadyLoggedIn = false;

function log(msg) {
  const time = new Date().toISOString();
  const fullMsg = `[${time}] ${msg}`;
  console.log(fullMsg);
  fs.appendFileSync('logs.txt', fullMsg + '\n');
}

function createBot() {
  log('Creating bot...');
  bot = mineflayer.createBot({
    host: config.host,
    port: config.port,
    username: config.username,
    version: config.version,
    auth: 'offline'
  });

  bot.loadPlugin(pathfinder);

  bot.once('login', () => {
    log('Bot logged in to the server.');
  });

  bot.once('spawn', () => {
    log('Bot has spawned in the world.');

    mcData = mcDataLoader(bot.version);
    defaultMove = new Movements(bot, mcData);
    defaultMove.allow1by1tallDoors = true;
    bot.pathfinder.setMovements(defaultMove);

    bot.on('chat', onChat);
    bot.on('physicsTick', eatIfHungry);

    runLoop();
  });

  bot.on('message', msg => {
    const text = msg.toString().toLowerCase();
    log(`Server Message: ${text}`);
    if (alreadyLoggedIn) return;
    if (text.includes('register')) {
      bot.chat(`/register ${config.password} ${config.password}`);
      alreadyLoggedIn = true;
      log('Sent register command.');
    } else if (text.includes('login')) {
      bot.chat(`/login ${config.password}`);
      alreadyLoggedIn = true;
      log('Sent login command.');
    }
  });

  bot.on('kicked', reason => log(`[KICKED] ${reason}`));
  bot.on('error', err => log(`[ERROR] ${err.message}`));
  bot.on('end', () => {
    log('Bot disconnected. Reconnecting in 5 seconds...');
    setTimeout(createBot, 5000);
  });
}

function onChat(username, message) {
  if (username === bot.username) return;
  if (message === '!stop') isRunning = false;
  if (message === '!start') isRunning = true;
  if (message === '!sleep') sleepRoutine();
  if (message === '!roam') houseRoamRoutine();
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

async function runLoop() {
  while (true) {
    if (!isRunning || sleeping) {
      await new Promise(r => setTimeout(r, 3000));
      continue;
    }

    const dayTime = bot.time.dayTime;

    // Sleep at night (dayTime 13000 to 23458)
    if (dayTime >= 13000 && dayTime <= 23458) {
      await sleepRoutine();
    } else {
      // Daytime: search for food in chests, eat, and roam inside house
      await searchFoodInChests();
      await houseRoamRoutine();
    }

    await new Promise(r => setTimeout(r, 5000));
  }
}

async function sleepRoutine() {
  const bed = bot.findBlock({
    matching: b => bot.isABed(b),
    maxDistance: config.searchRange
  });
  if (!bed) {
    log('No bed found within search range.');
    return;
  }
  log('Trying to sleep...');
  try {
    await goTo(config.entrance);
    await goTo(bed.position);
    await bot.sleep(bed);
    sleeping = true;
    bot.once('wake', () => {
      log('Woke up!');
      sleeping = false;
    });
  } catch (e) {
    log(`Sleep failed: ${e.message}`);
  }
}

async function searchFoodInChests() {
  for (let chestPos of config.chestPositions) {
    const chestBlock = bot.blockAt(new Vec3(chestPos.x, chestPos.y, chestPos.z));
    if (!chestBlock) continue;

    try {
      const chest = await bot.openContainer(chestBlock);
      log(`Opened chest at ${chestPos.x}, ${chestPos.y}, ${chestPos.z}`);

      // Check for food in chest slots
      const foodItem = chest.containerItems().find(item => item && mcData.items[item.type].food);
      if (foodItem) {
        // Withdraw food from chest to inventory (up to 1 stack or amount bot can carry)
        const toWithdraw = Math.min(foodItem.count, foodItem.type); // Just withdraw what’s available
        await chest.withdraw(foodItem.type, null, toWithdraw);
        log(`Withdrew ${toWithdraw} of ${mcData.items[foodItem.type].name} from chest.`);
      }

      chest.close();
    } catch (e) {
      log(`Failed to open chest or withdraw food: ${e.message}`);
    }
  }
}

async function houseRoamRoutine() {
  log('Roaming inside house.');
  bot.chat(config.chatAnnouncements.houseMessage);
  const houseCenter = config.houseCenter;
  const houseBounds = { x: 5, z: 5 }; // Adjust these values for house dimensions

  // Randomly pick a spot inside the house within bounds
  const offsetX = Math.floor(Math.random() * (houseBounds.x * 2 + 1)) - houseBounds.x;
  const offsetZ = Math.floor(Math.random() * (houseBounds.z * 2 + 1)) - houseBounds.z;

  const target = new Vec3(houseCenter.x + offsetX, houseCenter.y, houseCenter.z + offsetZ);

  // Log and move to the random position
  log(`Target roaming position: (${target.x}, ${target.y}, ${target.z})`);
  await goTo(target);
}

async function goTo(pos) {
  try {
    log(`Navigating to position (${pos.x}, ${pos.y}, ${pos.z})`);
    await bot.pathfinder.goto(new GoalNear(pos.x, pos.y, pos.z, 1));
    log(`Arrived at position (${pos.x}, ${pos.y}, ${pos.z})`);
  } catch (e) {
    log(`Failed to path to (${pos.x}, ${pos.y}, ${pos.z}): ${e.message}`);
  }
}

createBot();
