```js
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
let stats = {
  success: 0,
  fail: 0
};

let logs = [];
let accountStatus = {};
let isRunning = false;

/*
   Flood wait records
*/
let floodWaits = [];

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
      {
        connectionRetries: 5
      }
    );

    accountStatus[`account${i}`] = "UNKNOWN";
  }
}

/* =========================
   HELPERS
========================= */

const sleep = (ms) =>
  new Promise(resolve => setTimeout(resolve, ms));

async function safeConnect(client) {
  try {
    await client.connect();
  } catch (err) {
    console.log("Connect error:", err.message);
  }
}

/* =========================
   ACCOUNT CHECK
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

/* =========================
   REFRESH ACCOUNT STATUS
========================= */

async function refreshAccountStatus() {
  for (const name of Object.keys(clients)) {
    await checkAccount(name, clients[name]);
  }
}

/* Initial account check */
refreshAccountStatus();

/* =========================
   ACCOUNTS
========================= */

app.get("/accounts", (req, res) => {

  const result = Object.keys(clients).map(name => ({
    name: name,

    /*
      Phone is not read from environment.
      Keep empty if phone is not available.
    */
    phone: "",

    status: accountStatus[name] || "UNKNOWN"
  }));

  res.json(result);
});

/* =========================
   ACCOUNT STATUS
========================= */

app.get("/account-status", async (req, res) => {

  await refreshAccountStatus();

  res.json(
    Object.keys(clients).map(name => ({
      account: name,
      status: accountStatus[name] || "ERROR"
    }))
  );
});

/* =========================
   MANUAL ACCOUNT CHECK
========================= */

app.post("/check-accounts", async (req, res) => {

  await refreshAccountStatus();

  res.json({
    success: true,
    message: "Account status updated"
  });
});

/* =========================
   FLOOD WAITS
========================= */

/*
  IMPORTANT:
  This endpoint must exist because index.html calls:

  GET /flood-waits
*/

app.get("/flood-waits", (req, res) => {

  const now = Date.now();

  /*
    Remove expired flood waits
  */
  floodWaits = floodWaits.filter(item => {
    const end = new Date(item.endTime).getTime();
    return end > now;
  });

  /*
    Update remaining seconds
  */
  floodWaits = floodWaits.map(item => {

    const end = new Date(item.endTime).getTime();

    const remainingSec = Math.max(
      0,
      Math.ceil((end - now) / 1000)
    );

    return {
      ...item,
      remainingSec
    };
  });

  res.json(floodWaits);
});

/* =========================
   RETRY
========================= */

/*
  Keep endpoint so the frontend does not receive 404.

  Automatic retry is intentionally not performed.
*/

app.post("/retry", (req, res) => {

  res.status(400).json({
    success: false,
    message: "Retry is not available."
  });
});

/* =========================
   EXPORT MEMBERS
========================= */

app.post("/export-members", async (req, res) => {

  const {
    account,
    group,
    filterMembers,
    filterLastOnline,
    filterPhoto
  } = req.body;

  const client = clients[account];

  if (!client) {
    return res.json({
      success: false,
      error: "Account not found"
    });
  }

  try {

    await safeConnect(client);

    const participants =
      await client.getParticipants(group);

    let filtered = participants;

    /*
      Username filter
    */

    if (filterMembers === "username") {

      filtered = filtered.filter(
        p => p.username
      );
    }

    /*
      Profile photo filter
    */

    if (filterPhoto === "has") {

      filtered = filtered.filter(
        p => p.photo
      );
    }

    /*
      Convert to username / ID
    */

    const ids = filtered
      .map(p => p.username || p.id)
      .filter(Boolean);

    res.json({
      success: true,
      ids
    });

  } catch (err) {

    console.log(
      "Export error:",
      err.message
    );

    res.json({
      success: false,
      error: err.message
    });
  }
});

/* =========================
   START
========================= */

app.post("/start", async (req, res) => {

  const {
    group,
    usernames,
    accounts
  } = req.body;

  if (isRunning) {

    return res.json({
      message: "Already running"
    });
  }

  if (!group) {

    return res.json({
      message: "Target group required"
    });
  }

  if (!Array.isArray(usernames) || usernames.length === 0) {

    return res.json({
      message: "No members provided"
    });
  }

  if (!Array.isArray(accounts) || accounts.length === 0) {

    return res.json({
      message: "No accounts selected"
    });
  }

  await refreshAccountStatus();

  const activeAccounts = accounts.filter(
    name => accountStatus[name] === "ACTIVE"
  );

  if (!activeAccounts.length) {

    return res.json({
      message: "No ACTIVE accounts found"
    });
  }

  isRunning = true;

  stats = {
    success: 0,
    fail: 0
  };

  logs = [];

  let uIndex = 0;
  let aIndex = 0;

  while (
    isRunning &&
    uIndex < usernames.length
  ) {

    const accountName =
      activeAccounts[aIndex];

    const client =
      clients[accountName];

    const username =
      usernames[uIndex];

    try {

      await safeConnect(client);

      const user =
        await client.getEntity(username);

      const groupEntity =
        await client.getEntity(group);

      /*
        Existing Telegram operation
      */

      await client.invoke(
        new Api.channels.InviteToChannel({
          channel: groupEntity,
          users: [user]
        })
      );

      await sleep(2000);

      /*
        Verify
      */

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

        logs.push({
          username,
          status: "success",
          account: accountName
        });

      } else {

        stats.fail++;

        logs.push({
          username,
          status: "fail",
          account: accountName,
          error: "Verification failed"
        });
      }

      uIndex++;

    } catch (err) {

      const message =
        err?.message || String(err);

      console.log(
        `[${accountName}] ${username}: ${message}`
      );

      /*
        Record FLOOD_WAIT for UI.
      */

      if (
        message.includes("FLOOD_WAIT")
      ) {

        const match =
          message.match(
            /FLOOD_WAIT[_\s]*(\d+)/i
          );

        const seconds =
          match
            ? parseInt(match[1])
            : 0;

        const endTime =
          new Date(
            Date.now() +
            seconds * 1000
          ).toISOString();

        floodWaits.push({
          username,
          account: accountName,
          endTime,
          remainingSec: seconds
        });

        accountStatus[accountName] =
          "FLOOD";

        logs.push({
          username,
          status: "fail",
          account: accountName,
          error: "FLOOD_WAIT"
        });

        stats.fail++;

        /*
          Stop instead of bypassing
          the rate limit.
        */

        isRunning = false;

        break;

      } else {

        stats.fail++;

        logs.push({
          username,
          status: "fail",
          account: accountName,
          error: message
        });

        uIndex++;
      }
    }

    if (isRunning) {
      await sleep(DELAY);
    }
  }

  isRunning = false;

  res.json({
    message: "Finished"
  });
});

/* =========================
   STOP
========================= */

app.post("/stop", (req, res) => {

  isRunning = false;

  res.json({
    message: "Stopped"
  });
});

/* =========================
   RESTART
========================= */

app.post("/restart", (req, res) => {

  isRunning = false;

  stats = {
    success: 0,
    fail: 0
  };

  logs = [];

  /*
    Clear expired / old flood records
  */
  floodWaits = [];

  res.json({
    message: "Restarted"
  });
});

/* =========================
   STATS
========================= */

app.get("/stats", (req, res) => {

  res.json(stats);
});

/* =========================
   MEMBER LOGS
========================= */

app.get("/member-logs", (req, res) => {

  res.json(
    logs.slice(-500)
  );
});

/* =========================
   HEALTH CHECK
========================= */

app.get("/health", (req, res) => {

  res.json({
    success: true,
    status: "online",
    accounts: Object.keys(clients).length,
    running: isRunning
  });
});

/* =========================
   START SERVER
========================= */

app.listen(PORT, () => {

  console.log(
    `Server running on port ${PORT}`
  );

  console.log(
    `Accounts loaded: ${Object.keys(clients).length}`
  );
});
```

### បន្ទាប់ពីដាក់ Code នេះ

ធ្វើ៖

```text
Save server.js
       ↓
Git add / commit / push
       ↓
Render Auto Deploy
       ↓
Refresh Browser
```

ហើយសាកល្បង URL នេះ៖

[https://sream-member-tg-1.onrender.com/flood-waits](https://sream-member-tg-1.onrender.com/flood-waits?utm_source=chatgpt.com)

បើត្រឹមត្រូវ វានឹងបង្ហាញ៖

```json
[]
```

បន្ទាប់មក error នេះ៖

```text
GET /flood-waits 404
Unexpected token '<'
```

នឹងបាត់។
