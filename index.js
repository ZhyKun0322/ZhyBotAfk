const mineflayer = require('mineflayer');
const { pathfinder, Movements, goals: { GoalNear } } = require('mineflayer-pathfinder');
const Vec3 = require('vec3');
const mcDataLoader = require('minecraft-data');
const fs = require('fs');
const config = require('./config.json');
const fetch = require('node-fetch'); // For Hugging Face API requests

let bot, mcData, defaultMove;
let sleeping = false;
let isRunning = true;
let isEating = false;
let alreadyLoggedIn = false;

const HF_API_KEY = process.env.HF_API_KEY;  // Ensure to set Hugging Face API key in Termux or config.json

// Log function to print messages to console and write to a log file
function log(msg) {
  const time = new Date().toISOString();
  const fullMsg = `[${time}] ${msg}`;
  console.log(fullMsg);
  fs.appendFileSync('logs.txt', fullMsg + '\n');
}

// Function to create and login the bot
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
    defaultMove.canDig = false;
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
    } else if (text.includes('login')) {
      bot.chat(`/login ${config.password}`);
      alreadyLoggedIn = true;
    }
  });

  bot.on('kicked', reason => log(`[KICKED] ${reason}`));
  bot.on('error', err => log(`[ERROR] ${err.message}`));
  bot.on('end', () => {
    log('Bot disconnected. Reconnecting in 5 seconds...');
    setTimeout(createBot, 5000);
  });
}

// Function to handle chat input
function onChat(username, message) {
  if (username === bot.username) return;

  if (message === '#sleep') {
    bot.chat("Trying to sleep...");
    sleepRoutine();
    return;
  }

  if (username !== 'ZhyKun') return;

  if (message === '#stop') {
    isRunning = false;
    bot.chat("Bot paused.");
  }
  if (message === '#start') {
    isRunning = true;
    bot.chat("Bot resumed.");
  }
  if (message === '#roam') {
    bot.chat("Wandering around...");
    wanderRoutine();
  }
  if (message === '#come') {
    const player = bot.players[username]?.entity;
    if (player) {
      bot.chat('Coming to you!');
      goTo(player.position);
    } else {
      bot.chat('Cannot find you!');
    }
  }

  if (message.startsWith('#ask')) {
    const question = message.slice(4).trim();
    if (question) {
      askHuggingFace(question);
    } else {
      bot.chat('Please ask a question after #ask.');
    }
  }
}

// Function to interact with Hugging Face API
async function askHuggingFace(question) {
  if (!HF_API_KEY) {
    bot.chat("Hugging Face API key is missing!");
    return;
  }

  const url = 'https://api-inference.huggingface.co/models/distilbert-base-uncased';
  const headers = {
    'Authorization': `Bearer ${HF_API_KEY}`,
    'Content-Type': 'application/json'
  };
  
  const body = JSON.stringify({ inputs: question });

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: headers,
      body: body
    });

    const data = await response.json();

    if (data && data[0] && data[0].generated_text) {
      const answer = data[0].generated_text;
      bot.chat(`Answer: ${answer}`);
    } else {
      bot.chat("Sorry, I couldn't get a valid response.");
    }
  } catch (error) {
    bot.chat(`Error while asking Hugging Face: ${error.message}`);
  }
}

// Function to make the bot eat if it's hungry
function eatIfHungry() {
  if (isEating || bot.food === 20) return;

  const foodItem = bot.inventory.items().find(item => {
    const itemInfo = mcData.items[item.type];
    return itemInfo && itemInfo.food;
  });

  if (!foodItem) return;

  isEating = true;
  bot.equip(foodItem, 'hand')
    .then(() => bot.consume())
    .then(() => log(`Bot ate ${mcData.items[foodItem.type].name}`))
    .catch(err => log(`Error eating: ${err.message}`))
    .finally(() => isEating = false);
}

// Main loop for bot actions
async function runLoop() {
  while (true) {
    if (!isRunning || sleeping) {
      await delay(3000);
      continue;
    }

    const dayTime = bot.time.dayTime;

    if (dayTime >= 13000 && dayTime <= 23458) {
      await sleepRoutine();
    } else {
      await wanderRoutine();
    }

    await delay(5000);
  }
}

// Sleep routine function
async function sleepRoutine() {
  if (sleeping) return;
  const bed = bot.findBlock({
    matching: b => bot.isABed(b),
    maxDistance: config.searchRange
  });

  if (!bed) {
    log('No bed found nearby.');
    return;
  }

  log(`Heading to bed at ${bed.position}`);
  try {
    await goTo(bed.position);
    await bot.sleep(bed);
    sleeping = true;
    bot.chat("Sleeping now...");
    log('Sleeping...');

    bot.once('wake', () => {
      sleeping = false;
      bot.chat("Woke up!");
      log('Woke up from sleep.');
    });
  } catch (e) {
    log(`Sleep failed: ${e.message}`);
    bot.chat(`Sleep failed: ${e.message}`);
  }
}

// Random wander routine function
async function wanderRoutine() {
  log('Wandering randomly...');
  for (let i = 0; i < 5; i++) {
    if (sleeping) return;
    const dx = Math.floor(Math.random() * 11) - 5;
    const dz = Math.floor(Math.random() * 11) - 5;
    const pos = bot.entity.position.offset(dx, 0, dz);
    await goTo(pos);
    await delay(3000);
  }
}

// Function to move the bot to a target position
async function goTo(pos) {
  try {
    await bot.pathfinder.goto(new GoalNear(pos.x, pos.y, pos.z, 1));
  } catch (e) {
    log(`Navigation error: ${e.message}`);
  }
}

// Delay function
function delay(ms) {
  return new Promise(r => setTimeout(r, ms));
}

createBot();
