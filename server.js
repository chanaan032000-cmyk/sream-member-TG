require("dotenv").config();
const express = require("express");
const path = require("path");
const cors = require("cors");
const { TelegramClient } = require("telegram");
const { StringSession } = require("telegram/sessions");
const { Api } = require("telegram");

const app = express();

app.use(express.json());
app.use(cors());

/* =========================
   CONFIG
========================= */
const PORT = process.env.PORT || 3000;
const DELAY = parseInt(process.env.DELAY_MS) || 30000;

/* =========================
   SERVE INDEX
========================= */
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

/* =========================
   STATE
========================= */
let clients = {};
let stats = { success: 0, fail: 0 };
let logs = [];
let accountStatus = {};
let isRunning = false;

/* =========================
   LOAD ACCOUNTS
========================= */
for (let i = 1; i <= 10; i++) {
  const apiId = process.env[`API_ID_${i}`];
  const apiHash = process.env[`API_HASH_${i}`];
  const session = process.env[`SESSION_${i}`];

  if (apiId && apiHash && session) {
    clients[`account${i}`] = new TelegramClient(
      new StringSession(session),
      parseInt(apiId),
      apiHash,
      { connectionRetries: 5 }
    );
  }
}

/* =========================
   HELPERS
========================= */
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function safeConnect(client) {
  try {
    await client.connect();
  } catch {}
}

/* =========================
   ACCOUNT CHECK (FIXED)
========================= */
async function checkAccount(name, client) {
  try {
    await safeConnect(client);

    const me = await client.getMe();

    if (me && me.id) {
      accountStatus[name] = "ACTIVE";
    } else {
      accountStatus[name] = "ERROR";
    }

  } catch (err) {
    if (err.message?.includes("FLOOD_WAIT")) {
      accountStatus[name] = "FLOOD";
    } else {
      accountStatus[name] = "ERROR";
    }
  }
}

/* AUTO CHECK ON START */
async function refreshAccountStatus() {
  for (const name of Object.keys(clients)) {
    await checkAccount(name, clients[name]);
  }
}

refreshAccountStatus();

/* =========================
   ROUTES
========================= */
app.get("/accounts", (req, res) => {
  res.json(Object.keys(clients));
});

/* LIVE STATUS FIX */
app.get("/account-status", async (req, res) => {
  await refreshAccountStatus();

  res.json(
    Object.keys(clients).map(name => ({
      account: name,
      status: accountStatus[name] || "ERROR"
    }))
  );
});

/* MANUAL CHECK */
app.post("/check-accounts", async (req, res) => {
  await refreshAccountStatus();
  res.json({ message: "Account status updated" });
});

/* EXPORT MEMBERS */
app.post("/export-members", async (req, res) => {
  const { account, group } = req.body;

  const client = clients[account];
  if (!client) return res.json({ success: false, error: "Account not found" });

  try {
    await safeConnect(client);

    const participants = await client.getParticipants(group);
    const ids = participants.map(p => p.username || p.id).filter(Boolean);

    res.json({ success: true, ids });

  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

/* =========================
   START (REAL CHECK FIX)
========================= */
app.post("/start", async (req, res) => {
  const { group, usernames, accounts } = req.body;

  if (isRunning) return res.json({ message: "Already running" });

  await refreshAccountStatus();

  const activeAccounts = accounts.filter(
    a => accountStatus[a] === "ACTIVE"
  );

  if (!activeAccounts.length)
    return res.json({ message: "No ACTIVE accounts found" });

  isRunning = true;
  stats = { success: 0, fail: 0 };
  logs = [];

  let uIndex = 0;
  let aIndex = 0;

  while (isRunning && uIndex < usernames.length) {

    const accountName = activeAccounts[aIndex];
    const client = clients[accountName];
    const username = usernames[uIndex];

    try {
      await safeConnect(client);

      const user = await client.getEntity(username);
      const groupEntity = await client.getEntity(group);

      await client.invoke(
        new Api.channels.InviteToChannel({
          channel: groupEntity,
          users: [user]
        })
      );

      await sleep(2000);

      // REAL VERIFY
      let ok = false;
      try {
        await client.invoke(
          new Api.channels.GetParticipant({
            channel: groupEntity,
            participant: user
          })
        );
        ok = true;
      } catch {
        ok = false;
      }

      if (ok) {
        stats.success++;
        logs.push({ username, status: "success" });
      } else {
        stats.fail++;
        logs.push({ username, status: "fail" });
      }

      uIndex++;

    } catch (err) {
      if (err.message?.includes("FLOOD_WAIT")) {
        aIndex = (aIndex + 1) % activeAccounts.length;
      } else {
        stats.fail++;
        logs.push({ username, status: "fail" });
        uIndex++;
      }
    }

    await sleep(DELAY);
  }

  isRunning = false;

  res.json({ message: "Finished" });
});

/* =========================
   STOP / RESTART
========================= */
app.post("/stop", (req, res) => {
  isRunning = false;
  res.json({ message: "Stopped" });
});

app.post("/restart", (req, res) => {
  isRunning = false;
  stats = { success: 0, fail: 0 };
  logs = [];
  res.json({ message: "Restarted" });
});

/* =========================
   STATS
========================= */
app.get("/stats", (req, res) => {
  res.json(stats);
});

/* =========================
   LOGS
========================= */
app.get("/member-logs", (req, res) => {
  res.json(logs.slice(-500));
});

/* =========================
   START SERVER
========================= */
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
