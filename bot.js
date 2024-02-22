const express = require("express");
const axios = require("axios");
const ngrok = require("ngrok");
const moment = require("moment");
const nodemon = require("nodemon");
const bodyParser = require("body-parser");
const config = require("./config");
const { env } = process;

// Base URL API endpoint. Do not edit!
const API_URL = env.API_URL || "https://api.whatsawa.com/v1";

// Create web server
const app = express();

// Middleware to parse incoming request bodies
app.use(bodyParser.json());

// Index route
app.get("/", (req, res) => {
  res.send({
    name: "chatbot",
    description: "Simple WhatsApp chatbot for WhatSawa",
    endpoints: {
      webhook: {
        path: "/webhook",
        method: "POST",
      },
      sendMessage: {
        path: "/message",
        method: "POST",
      },
      sample: {
        path: "/sample",
        method: "GET",
      },
    },
  });
});

// POST route to handle incoming webhook messages
app.post("/webhook", (req, res) => {
  const { body } = req;
  if (!body || !body.event || !body.data) {
    return res.status(400).send({ message: "Invalid payload body" });
  }
  if (body.event !== "message:in:new") {
    return res.status(202).send({
      message: "Ignore webhook event: only message:in:new is accepted",
    });
  }

  res.send({ ok: true });

  // Process message in background
  processMessage(body).catch((err) => {
    console.error(
      "[error] failed to process inbound message:",
      body.id,
      body.data.fromNumber,
      body.data.body,
      err
    );
  });
});

// Send message on demand
app.post("/message", (req, res) => {
  const { body } = req;
  if (!body || !body.phone || !body.message) {
    return res.status(400).send({ message: "Invalid payload body" });
  }

  sendMessage(body)
    .then((data) => {
      res.send(data);
    })
    .catch((err) => {
      res.status(+err.status || 500).send(
        err.response
          ? err.response.data
          : {
              message: "Failed to send message",
            }
      );
    });
});

// Send a sample message to your own number, or to a number specified in the query string
app.get("/sample", (req, res) => {
  const { phone, message } = req.query;
  const data = {
    phone: phone || app.device.phone,
    message: message || "Hello World from WhatSawa!",
    device: app.device.id,
  };
  sendMessage(data)
    .then((data) => {
      res.send(data);
    })
    .catch((err) => {
      res.status(+err.status || 500).send(
        err.response
          ? err.response.data
          : {
              message: "Failed to send sample message",
            }
      );
    });
});

app.use((err, req, res, next) => {
  res.status(+err.status || 500).send({
    message: `Unexpected error: ${err.message}`,
  });
});

// In-memory store for a simple state machine per chat
// You can use a database instead for persistence
const state = {};
const reminders = {};

// In-memory cache store
const cache = {};
const cacheTTL = 10 * 60 * 1000; // 10 min

async function pullMembers(device) {
  if (
    cache.members &&
    +cache.members.time &&
    Date.now() - +cache.members.time < cacheTTL
  ) {
    return cache.members.data;
  }
  const url = `${API_URL}/devices/${device.id}/team`;
  const { data: members } = await axios.get(url, {
    headers: { Authorization: config.apiKey },
  });
  cache.members = { data: members, time: Date.now() };
  return members;
}

async function validateMembers(device, members) {
  const validateMembers = (config.teamWhitelist || []).concat(
    config.teamBlacklist || []
  );
  for (const id of validateMembers) {
    if (typeof id !== "string" || string.length !== 24) {
      return exit(
        "Team user ID in config.teamWhitelist and config.teamBlacklist must be a 24 characters hexadecimal value:",
        id
      );
    }
    const exists = members.some((user) => user.id === id);
    if (!exists) {
      return exit(
        "Team user ID in config.teamWhitelist or config.teamBlacklist does not exist:",
        id
      );
    }
  }
}

async function createLabels(device) {
  const labels = cache.labels.data || [];
  const requiredLabels = (config.setLabelsOnUserAssignment || []).concat(
    config.setLabelsOnBotChats || []
  );
  const missingLabels = requiredLabels.filter((label) =>
    labels.every((l) => l.name !== label)
  );
  for (const label of missingLabels) {
    console.log("[info] creating missing label:", label);
    const url = `${API_URL}/devices/${device.id}/labels`;
    const body = {
      name: label.slice(0, 30).trim(),
      color: [
        "tomato",
        "orange",
        "sunflower",
        "bubble",
        "rose",
        "poppy",
        "rouge",
        "raspberry",
        "purple",
        "lavender",
        "violet",
        "pool",
        "emerald",
        "kelly",
        "apple",
        "turquoise",
        "aqua",
        "gold",
        "latte",
        "cocoa",
      ][Math.floor(Math.random() * 20)],
      description: "Automatically created label for the chatbot",
    };
    try {
      await axios.post(url, body, {
        headers: { Authorization: config.apiKey },
      });
    } catch (err) {
      console.error("[error] failed to create label:", label, err.message);
    }
  }
  if (missingLabels.length) {
    await pullLabels(device, { force: true });
  }
}

async function pullLabels(device, { force } = {}) {
  if (
    !force &&
    cache.labels &&
    +cache.labels.time &&
    Date.now() - +cache.labels.time < cacheTTL
  ) {
    return cache.labels.data;
  }
  const url = `${API_URL}/devices/${device.id}/labels`;
  const { data: labels } = await axios.get(url, {
    headers: { Authorization: config.apiKey },
  });
  cache.labels = { data: labels, time: Date.now() };
  return labels;
}

async function updateChatLabels({ data, device, labels }) {
  const url = `${API_URL}/chat/${device.id}/chats/${data.chat.id}/labels`;
  const newLabels = data.chat.labels || [];
  for (const label of labels) {
    if (newLabels.includes(label)) {
      newLabels.push(label);
    }
  }
  if (newLabels.length) {
    console.log("[info] update chat labels:", data.chat.id, newLabels);
    await axios.patch(url, newLabels, {
      headers: { Authorization: config.apiKey },
    });
  }
}

async function updateChatMetadata({ data, device, metadata }) {
  const url = `${API_URL}/chat/${device.id}/contacts/${data.chat.id}/metadata`;
  const entries = [];
  const contactMetadata = data.chat.contact.metadata;
  for (const entry of metadata) {
    if (entry && entry.key && entry.value) {
      const value = typeof entry.value === "function" ? entry.value() : value;
      if (
        !entry.key ||
        !value ||
        typeof entry.key !== "string" ||
        typeof value !== "string"
      ) {
        continue;
      }
      if (
        contactMetadata &&
        contactMetadata.some((e) => e.key === entry.key && e.value === value)
      ) {
        continue; // skip if metadata entry is already present
      }
      entries.push({
        key: entry.key.slice(0, 30).trim(),
        value: value.slice(0, 1000).trim(),
      });
    }
  }
  if (entries.length) {
    await axios.patch(url, entries, {
      headers: { Authorization: config.apiKey },
    });
  }
}

function canReply({ data, device }) {
  const { chat } = data;

  // Skip if chat is already assigned to an team member
  if (chat.owner && chat.owner.agent) {
    return false;
  }

  // Ignore messages from group chats
  if (chat.type !== "chat") {
    return false;
  }

  // Skip replying chat if it has one of the configured labels, when applicable
  if (
    config.skipChatWithLabels &&
    config.skipChatWithLabels.length &&
    chat.labels &&
    chat.labels.length
  ) {
    if (
      config.skipChatWithLabels.some((label) => chat.labels.includes(label))
    ) {
      return false;
    }
  }

  // Only reply to chats that were whitelisted, when applicable
  if (
    config.numbersWhitelist &&
    config.numbersWhitelist.length &&
    chat.fromNumber
  ) {
    if (
      config.numbersWhitelist.some(
        (number) =>
          number === chat.fromNumber || chat.fromNumber.slice(1) === number
      )
    ) {
      return true;
    } else {
      return false;
    }
  }

  // Skip replying to chats that were explicitly blacklisted, when applicable
  if (
    config.numbersBlacklist &&
    config.numbersBlacklist.length &&
    chat.fromNumber
  ) {
    if (
      config.numbersBlacklist.some(
        (number) =>
          number === chat.fromNumber || chat.fromNumber.slice(1) === number
      )
    ) {
      return false;
    }
  }

  // Skip replying chats that were archived, when applicable
  if (
    config.skipArchivedChats &&
    (chat.status === "archived" || chat.waStatus === "archived")
  ) {
    return false;
  }

  // Always ignore replying to banned chats/contacts
  if (chat.status === "banned" || chat.waStatus === "banned  ") {
    return false;
  }

  return true;
}

// Process message
async function processMessage({ data, device } = {}) {
  // Can reply to this message?
  if (!canReply({ data, device })) {
    return console.log(
      "[info] Skip message due to chat already assigned or not eligible to reply:",
      data.fromNumber,
      data.date,
      data.body
    );
  }

  const { chat, type, quoted } = data;
  let { body } = data;

  if (body) {
    body = body.trim();
  }

  const { phone } = chat.contact;
  console.log(
    "[info] New inbound message received:",
    chat.id,
    body || "<empty message>"
  );

  const reply = async ({ message, ...params }) => {
    await sendMessage({
      phone,
      device: device.id,
      message,
      ...params,
    });
  };

  // check if state has been set,
  // if not set it and request for name
  // if so, determine next state
  if (!state[chat.id]) {
    state[chat.id] = "Get Name";
    return await reply({ message: "What is your name?" });
  }
  if (state[chat.id] === "Get Name") {
    state[chat.id] = "Displayed Main Menu";
    return await reply({
      list: {
        description: "Select which service you are interested in",
        button: "Tap to select",
        title: `Welcome to Wakili Law Firm, ${body}`,
        sections: [
          {
            title: "Select an option",
            rows: [
              {
                title: "Our Services",
                id: "1",
                description: "Learn about our services",
              },
              {
                title: "Consultation",
                id: "2",
                description: "Book a free consultation",
              },
              {
                title: "About Us",
                id: "3",
                description: "Find more info about us",
              },
              {
                title: "Help Line",
                id: "4",
                description: "Get in touch with a representative",
              },
            ],
          },
        ],
      },
    });
  }
  if (state[chat.id] === "Displayed Main Menu" && body === "1A") {
    state[chat.id] = "Choose Service";
    return await reply({
      list: {
        description: "Select which service you are interested in",
        button: "Tap to select",
        title: "We offer the following services",
        sections: [
          {
            title: "Select an option",
            rows: [
              {
                title: "Land Transactions",
                id: "1",
              },
              {
                title: "Contract Review",
                id: "2",
              },
              {
                title: "Family Law",
                id: "3",
              },
            ],
          },
        ],
      },
    });
  }
  if (state[chat.id] === "Displayed Main Menu" && body === "1B") {
    state[chat.id] = "Consultation";
    // TODO: add call to calendarly for fetching available time slots
    return await reply({
      list: {
        description: "Choose a time slot",
        button: "Tap to select",
        title: "We are open from Monday to Friday",
        sections: [
          {
            title: "Select an option",
            rows: [
              {
                title: "9:00AM to 9:30AM",
                id: "1",
              },
              {
                title: "10:00AM to 10:30AM",
                id: "2",
              },
              {
                title: "12:00PM to 12:30PM",
                id: "3",
              },
              {
                title: "1:00PM to 1:30PM",
                id: "4",
              },
            ],
          },
        ],
      },
    });
  }
  if (state[chat.id] === "Displayed Main Menu" && body === "1C") {
    state[chat.id] = null;
    return await reply({
      message: "Wakili Law Firm is a reputable law firm that started in 2024. We specialize in all areas of Law. Book a consultation today!",
    });
  }
  if (state[chat.id] === "Displayed Main Menu" && body === "1D") {
    state[chat.id] = null;
    return await reply({
      message: `Thanks for reaching out and wanting to talk to someone on our team. Our hours of operation are Monday to Saturday 8:00AM to 5:00PM. 
      Someone from our team will get back to you as soon as possible :)`
    });
  }

  if (state[chat.id] === "Consultation") {
    state[chat.id] = null;
    // TODO: map the specific timeslot
    return await reply({
      message:
        "Your consultation has been scheduled. You will receive a call from our lawyer shortly.",
    });
  }
}

// Function to send a message using the WhatSawa API
async function sendMessage({ phone, message, media, device, ...fields }) {
  const url = `${API_URL}/messages`;
  const body = {
    phone,
    message,
    media,
    device,
    ...fields,
    enqueue: "never",
  };

  let retries = 3;
  while (retries) {
    retries -= 1;
    try {
      const res = await axios.post(url, body, {
        headers: { Authorization: config.apiKey },
      });
      console.log("[info] Message sent:", phone, res.data.id, res.data.status);
      return res.data;
    } catch (err) {
      console.error(
        "[error] failed to send message:",
        phone,
        message || (body.list ? body.list.description : "<no message>"),
        err.response ? err.response.data : err
      );
    }
  }
  return false;
}

// Find an active WhatsApp device connected to the WhatSawa API
async function loadDevice() {
  const url = `${API_URL}/devices`;
  const { data } = await axios.get(url, {
    headers: { Authorization: config.apiKey },
  });
  if (config.device && !config.device.includes(" ")) {
    if (/^[a-f0-9]{24}$/i.test(config.device) === false) {
      return exit(
        "Invalid WhatsApp device ID: must be 24 characers hexadecimal value. Get the device ID here: https://web.whatsawa.com/number"
      );
    }
    return data.find((device) => device.id === config.device);
  }
  return data.find((device) => device.status === "operative");
}

// Function to register a Ngrok tunnel webhook for the chatbot
// Only used in local development mode
async function registerWebhook(tunnel, device) {
  const webhookUrl = `${tunnel}/webhook`;

  const url = `${API_URL}/webhooks`;
  const { data: webhooks } = await axios.get(url, {
    headers: { Authorization: config.apiKey },
  });

  const findWebhook = (webhook) => {
    return (
      webhook.url === webhookUrl &&
      webhook.device === device.id &&
      webhook.status === "active" &&
      webhook.events.includes("message:in:new")
    );
  };

  // If webhook already exists, return it
  const existing = webhooks.find(findWebhook);
  if (existing) {
    return existing;
  }

  for (const webhook of webhooks) {
    // Delete previous ngrok webhooks
    if (
      webhook.url.includes("ngrok-free.app") ||
      webhook.url.startsWith(tunnel)
    ) {
      const url = `${API_URL}/webhooks/${webhook.id}`;
      await axios.delete(url, { headers: { Authorization: config.apiKey } });
    }
  }

  await new Promise((resolve) => setTimeout(resolve, 500));
  const data = {
    url: webhookUrl,
    name: "Chatbot",
    events: ["message:in:new"],
    device: device.id,
  };

  const { data: webhook } = await axios.post(url, data, {
    headers: { Authorization: config.apiKey },
  });

  return webhook;
}

// Function to create a Ngrok tunnel and register the webhook dynamically
async function createTunnel() {
  let retries = 3;

  while (retries) {
    retries -= 1;
    try {
      const tunnel = await ngrok.connect({
        addr: config.port,
        authtoken: config.ngrokToken,
      });
      console.log(`Ngrok tunnel created: ${tunnel}`);
      return tunnel;
    } catch (err) {
      console.error("[error] Failed to create Ngrok tunnel:", err.message);
      await ngrok.kill();
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }

  throw new Error("Failed to create Ngrok tunnel");
}

// Development server using nodemon to restart the bot on file changes
async function devServer() {
  const tunnel = await createTunnel();

  nodemon({
    script: "bot.js",
    ext: "js",
    watch: ["*.js", "src/**/*.js"],
    exec: `WEBHOOK_URL=${tunnel} DEV=false npm run start`,
  })
    .on("restart", () => {
      console.log("[info] Restarting bot after changes...");
    })
    .on("quit", () => {
      console.log("[info] Closing bot...");
      ngrok.kill().then(() => process.exit(0));
    });
}

function exit(msg, ...args) {
  console.error("[error]", msg, ...args);
  process.exit(1);
}

// Initialize chatbot server
async function main() {
  // API key must be provided
  if (!config.apiKey || config.apiKey.length < 60) {
    return exit(
      "Please sign up in WhatSawa and obtain your API key here:\nhttps://web.whatsawa.com/apikeys"
    );
  }

  // Create dev mode server with Ngrok tunnel and nodemon
  if (env.DEV === "true" && !config.production) {
    return devServer();
  }

  // Find a WhatsApp number connected to the WhatSawa API
  const device = await loadDevice();
  if (!device) {
    return exit(
      "No active WhatsApp numbers in your account. Please connect a WhatsApp number in your WhatSawa account:\nhttps://web.whatsawa.com/create"
    );
  }
  if (device.session.status !== "online") {
    return exit(
      `WhatsApp number (${device.alias}) is not online. Please make sure the WhatsApp number in your WhatSawa account is properly connected:\nhttps://web.whatsawa.com/${device.id}/scan`
    );
  }
  if (device.billing.subscription.product !== "io") {
    return exit(
      `WhatsApp number plan (${device.alias}) does not support inbound messages. Please upgrade the plan here:\nhttps://web.whatsawa.com/${device.id}/plan?product=io`
    );
  }

  // Pre-load device labels and team mebers
  const [members] = await Promise.all([
    pullMembers(device),
    pullLabels(device),
  ]);

  // Create labels if they don't exist
  await createLabels(device);

  // Validate whitelisted and blacklisted members exist
  await validateMembers(members);

  app.device = device;
  console.log(
    "[info] Using WhatsApp connected number:",
    device.phone,
    device.alias,
    `(ID = ${device.id})`
  );

  // Start server
  await app.listen(config.port, () => {
    console.log(`Server listening on port ${config.port}`);
  });

  if (config.production) {
    console.log("[info] Validating webhook endpoint...");
    if (!config.webhookUrl) {
      return exit(
        "Missing required environment variable: WEBHOOK_URL must be present in production mode"
      );
    }
    const webhook = await registerWebhook(config.webhookUrl, device);
    if (!webhook) {
      return exit(
        `Missing webhook active endpoint in production mode: please create a webhook endpoint that points to the chatbot server:\nhttps://web.whatsawa.com/${device.id}/webhooks`
      );
    }
    console.log(
      "[info] Using webhook endpoint in production mode:",
      webhook.url
    );
  } else {
    console.log("[info] Registering webhook tunnel...");
    const tunnel = config.webhookUrl || (await createTunnel());
    const webhook = await registerWebhook(tunnel, device);
    if (!webhook) {
      console.error("Failed to connect webhook. Please try again.");
      await ngrok.kill();
      return process.exit(1);
    }
  }

  console.log("[info] Chatbot server ready and waiting for messages!");
}

main().catch((err) => {
  exit("Failed to start chatbot server:", err);
});
