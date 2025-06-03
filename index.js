const mineflayer = require('mineflayer');
const { pathfinder, Movements, goals: { GoalBlock, GoalNear } } = require('mineflayer-pathfinder');
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
      .then(() => {
        bot.activateItem(); // replaces bot.consume()
        return new Promise(r => setTimeout(r, 1600)); // wait to simulate eating
      })
      .catch(err => {
        log(`Eating error: ${err.message}`);
      })
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
        const toWithdraw = foodItem.count;  // Fixed this line: withdraw all food count, not type
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

  const center = config.houseCenter;
  const radius = config.houseRadius || 5; // fallback to 5 if not defined

  for (let i = 0; i < 5; i++) {
    if (sleeping) return;

    const offsetX = Math.floor(Math.random() * (radius * 2 + 1)) - radius;
    const offsetZ = Math.floor(Math.random() * (radius * 2 + 1)) - radius;
    const target = new Vec3(center.x + offsetX, center.y, center.z + offsetZ);

    await goTo(target);
    await new Promise(r => setTimeout(r, 3000));
  }
}

async function goTo(pos) {
  try {
    await bot.pathfinder.goto(new GoalNear(pos.x, pos.y, pos.z, 1));
  } catch (e) {
    log(`Failed to path to (${pos.x}, ${pos.y}, ${pos.z}): ${e.message}`);
  }
}

createBot();
