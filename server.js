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

// Serve HTML
app.get("/", (req, res) => res.sendFile(path.join(__dirname, "index.html")));

const PORT = process.env.PORT || 3000;
const DELAY = parseInt(process.env.DELAY_MS) || 30000;

// --- Multi-account setup ---
let clients = {};
let accountsInfo = {};
for (let i = 1; i <= 10; i++) {
  const apiId = process.env[`API_ID_${i}`];
  const apiHash = process.env[`API_HASH_${i}`];
  const session = process.env[`SESSION_${i}`];
  const phone = process.env[`PHONE_${i}`];
  if (apiId && apiHash && session) {
    clients[`account${i}`] = new TelegramClient(
      new StringSession(session),
      parseInt(apiId),
      apiHash,
      { connectionRetries: 5 }
    );
    accountsInfo[`account${i}`] = { phone };
  }
}

// Connect all clients
(async () => {
  for (const name in clients) {
    try {
      await clients[name].connect();
      console.log(`✅ Connected ${name}`);
    } catch (err) {
      console.log(`❌ Failed to connect ${name}: ${err.message}`);
    }
  }
})();

// --- In-memory data ---
let stats = { success: 0, fail: 0 };
let memberLogs = [];
let floodWaits = []; // {username, account, endTime, remainingSec}
let isRunning = false;

// --- Helper: Auto join group ---
async function ensureJoined(client, group) {
  try {
    await client.getParticipants(group, { limit: 1 });
    return; // already joined
  } catch {}
  try {
    let hash = null;
    if (group.includes("t.me/")) hash = group.split("/").pop();
    if (hash) await client.invoke(new Api.messages.ImportChatInvite({ hash }));
  } catch {}
}

// --- Routes ---
app.get("/accounts", (req, res) => {
  const list = Object.keys(clients).map((name) => ({
    name,
    phone: accountsInfo[name]?.phone || "",
  }));
  res.json(list);
});

app.get("/stats", (req, res) => res.json(stats));
app.get("/member-logs", (req, res) => res.json(memberLogs));
app.get("/flood-waits", (req, res) => res.json(floodWaits));

// --- Export members ---
app.post("/export-members", async (req, res) => {
  const { account, group, filterMembers, filterLastOnline, filterPhoto } = req.body;
  const client = clients[account];
  if (!client) return res.json({ success: false, error: "Account not found" });

  try {
    await ensureJoined(client, group);
    let participants = [];
    for await (const user of client.iterParticipants(group)) participants.push(user);

    if (filterMembers === "username") participants = participants.filter((p) => p.username);
    if (filterPhoto === "has") participants = participants.filter((p) => p.photo);
    if (filterLastOnline !== "all") {
      const now = Date.now();
      participants = participants.filter((p) => {
        if (!p.status?.date) return false;
        const statusDate = new Date(p.status.date * 1000);
        if (filterLastOnline === "week") return now - statusDate <= 7 * 24 * 3600 * 1000;
        if (filterLastOnline === "month") return now - statusDate <= 30 * 24 * 3600 * 1000;
        return true;
      });
    }

    const ids = participants.map((p) => p.username || p.id);
    res.json({ success: true, ids });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

// --- Start adding members ---
app.post("/start", async (req, res) => {
  const { group, usernames, accounts } = req.body;
  if (!accounts?.length) return res.json({ message: "No accounts selected" });
  if (!group) return res.json({ message: "Target group required" });
  if (isRunning) return res.json({ message: "Already running" });

  isRunning = true;
  stats = { success: 0, fail: 0 };
  memberLogs = [];
  floodWaits = [];

  let userIndex = 0;
  let accountIndex = 0;

  const processNext = async () => {
    if (!isRunning || userIndex >= usernames.length) {
      isRunning = false;
      return;
    }

    const username = usernames[userIndex];

    // Skip accounts in FLOOD_WAIT
    let client, accountName;
    let attempts = 0;
    do {
      accountName = accounts[accountIndex];
      client = clients[accountName];
      attempts++;
      accountIndex = (accountIndex + 1) % accounts.length;
      if (attempts > accounts.length) {
        // All accounts in FLOOD_WAIT, wait 5s
        setTimeout(processNext, 5000);
        return;
      }
    } while (floodWaits.find(f => f.account === accountName && Date.now() < f.endTimeMs));

    await ensureJoined(client, group);

    try {
      await client.invoke(new Api.channels.InviteToChannel({ channel: group, users: [username] }));
      stats.success++;
      memberLogs.push({ username, status: "success", account: accountName });
      console.log(`✅ ${username} added by ${accountName}`);

      userIndex++;
      // Delay only after success
      setTimeout(processNext, DELAY);
    } catch (err) {
      if (err.message.includes("FLOOD_WAIT")) {
        const waitSec = parseInt(err.message.match(/\d+/)[0]);
        const endTimeMs = Date.now() + waitSec * 1000;
        floodWaits.push({
          username,
          account: accountName,
          endTime: new Date(endTimeMs).toLocaleString(),
          endTimeMs,
          remainingSec: waitSec
        });
        console.log(`⏳ FLOOD_WAIT for ${accountName} (${waitSec}s)`);
        memberLogs.push({ username, status: "fail", error: err.message, account: accountName });
        userIndex++; // Skip user, try next
        processNext(); // No delay here
      } else if (
        err.message.includes("USER_PRIVACY") ||
        err.message.includes("USER_ALREADY") ||
        err.message.includes("USER_BANNED")
      ) {
        stats.fail++;
        memberLogs.push({ username, status: "skipped", reason: err.message, account: accountName });
        userIndex++;
        processNext(); // No delay
      } else {
        stats.fail++;
        memberLogs.push({ username, status: "fail", error: err.message, account: accountName });
        userIndex++;
        processNext(); // No delay
      }
    }
  };

  processNext();
  res.json({ message: `Started with ${accounts.length} accounts, delay ${DELAY / 1000}s after success` });
});

// --- Stop ---
app.post("/stop", (req, res) => {
  isRunning = false;
  res.json({ message: "Stopped" });
});

// --- Restart ---
app.post("/restart", (req, res) => {
  isRunning = false;
  stats = { success: 0, fail: 0 };
  memberLogs = [];
  floodWaits = [];
  res.json({ message: "Restarted" });
});

// --- Retry single user ---
app.post("/retry", async (req, res) => {
  const { username, group } = req.body;
  const availableAccounts = Object.keys(clients);
  if (!group) return res.json({ error: "Target group required" });
  if (!availableAccounts.length) return res.json({ error: "No accounts available" });

  const accountName = availableAccounts[Math.floor(Math.random() * availableAccounts.length)];
  const client = clients[accountName];

  try {
    await ensureJoined(client, group);
    await client.invoke(new Api.channels.InviteToChannel({ channel: group, users: [username] }));
    res.json({ message: `${username} retried successfully with ${accountName}` });
  } catch (err) {
    res.json({ error: err.message });
  }
});

// --- Start server ---
app.listen(PORT, () => console.log(`Server running at http://localhost:${PORT}`));
