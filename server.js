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

   Example:
   {
     account: "account1",
     endTime: "2026-09-11T09:00:00.000Z",
     remainingSec: 120
   }
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
    return true;
  } catch (err) {
    return false;
  }
}

/* =========================
   FLOOD WAIT HELPER
========================= */
function addFloodWait(account, seconds) {
  const endTime = new Date(
    Date.now() + seconds * 1000
  ).toISOString();

  floodWaits = floodWaits.filter(
    item => item.account !== account
  );

  floodWaits.push({
    account,
    endTime,
    remainingSec: seconds
  });
}

function cleanupFloodWaits() {
  const now = Date.now();

  floodWaits = floodWaits
    .filter(item => {
      const end = new Date(item.endTime).getTime();
      return end > now;
    })
    .map(item => ({
      ...item,
      remainingSec: Math.max(
        0,
        Math.ceil(
          (new Date(item.endTime).getTime() - now) / 1000
        )
      )
    }));
}

/* =========================
   ACCOUNT CHECK
========================= */
async function checkAccount(name, client) {
  try {
    const connected = await safeConnect(client);

    if (!connected) {
      accountStatus[name] = "ERROR";
      return;
    }

    const me = await client.getMe();

    if (me && me.id) {
      accountStatus[name] = "ACTIVE";
    } else {
      accountStatus[name] = "ERROR";
    }

  } catch (err) {
    const message = err?.message || "";

    if (message.includes("FLOOD_WAIT")) {
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

/* Check accounts when server starts */
refreshAccountStatus();

/* =========================
   ACCOUNTS
========================= */
app.get("/accounts", (req, res) => {
  cleanupFloodWaits();

  const data = Object.keys(clients).map(name => ({
    name: name,
    phone: "",
    status: accountStatus[name] || "UNKNOWN"
  }));

  res.json(data);
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
   MANUAL CHECK
========================= */
app.post("/check-accounts", async (req, res) => {
  await refreshAccountStatus();

  res.json({
    message: "Account status updated"
  });
});

/* =========================
   FLOOD WAITS
========================= */
app.get("/flood-waits", (req, res) => {
  cleanupFloodWaits();

  res.json(floodWaits);
});

/*
   The frontend currently contains /retry.
   Return JSON instead of a 404 HTML page.
*/
app.post("/retry", (req, res) => {
  res.status(400).json({
    success: false,
    error: "Retry is not available from this endpoint."
  });
});

/* =========================
   EXPORT MEMBERS
========================= */
app.post("/export-members", async (req, res) => {
  const {
    account,
    group
  } = req.body;

  const client = clients[account];

  if (!client) {
    return res.json({
      success: false,
      error: "Account not found"
    });
  }

  try {
    const connected = await safeConnect(client);

    if (!connected) {
      return res.json({
        success: false,
        error: "Unable to connect account"
      });
    }

    const participants =
      await client.getParticipants(group);

    const ids = participants
      .map(p => p.username || p.id)
      .filter(Boolean);

    res.json({
      success: true,
      ids
    });

  } catch (err) {
    res.json({
      success: false,
      error: err?.message || "Export failed"
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

  if (!Array.isArray(usernames)) {
    return res.json({
      message: "Invalid usernames"
    });
  }

  if (!Array.isArray(accounts)) {
    return res.json({
      message: "Invalid accounts"
    });
  }

  await refreshAccountStatus();

  const activeAccounts = accounts.filter(
    account => accountStatus[account] === "ACTIVE"
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

  /*
     Keep the existing processing structure.
     Flood waits are recorded for UI visibility.
  */
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
      const connected =
        await safeConnect(client);

      if (!connected) {
        stats.fail++;

        logs.push({
          username,
          account: accountName,
          status: "fail",
          error: "Unable to connect account"
        });

        uIndex++;
        continue;
      }

      const user =
        await client.getEntity(username);

      const groupEntity =
        await client.getEntity(group);

      /*
         Existing operation remains here.
      */
      await client.invoke(
        new Api.channels.InviteToChannel({
          channel: groupEntity,
          users: [user]
        })
      );

      await sleep(2000);

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
          account: accountName,
          status: "success"
        });

      } else {
        stats.fail++;

        logs.push({
          username,
          account: accountName,
          status: "fail",
          error: "Verification failed"
        });
      }

      uIndex++;

    } catch (err) {
      const message =
        err?.message || "Unknown error";

      /*
         Detect Telegram Flood Wait
      */
      const match =
        message.match(/FLOOD_WAIT[_\s]*(\d+)/i);

      if (match) {
        const seconds =
          parseInt(match[1]);

        addFloodWait(
          accountName,
          seconds
        );

        accountStatus[accountName] =
          "FLOOD";

        logs.push({
          username,
          account: accountName,
          status: "flood",
          error: `FLOOD_WAIT ${seconds}s`
        });

        /*
           Move to next selected account.
        */
        aIndex =
          (aIndex + 1) %
          activeAccounts.length;

      } else {
        stats.fail++;

        logs.push({
          username,
          account: accountName,
          status: "fail",
          error: message
        });

        uIndex++;
      }
    }

    cleanupFloodWaits();

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
   LOGS
========================= */
app.get("/member-logs", (req, res) => {
  res.json(
    logs.slice(-500)
  );
});

/* =========================
   START SERVER
========================= */
app.listen(PORT, () => {
  console.log(
    `Server running on port ${PORT}`
  );
});
```

**ចំណាំ:** ក្នុង `index.html` របស់អ្នក `restart()` មាន **2 ដង**។ លុប function មួយចេញផង។ ក្រោយ Deploy ថ្មី សាកល្បងបើក៖

```text
https://sream-member-tg-1.onrender.com/flood-waits
```

វាគួរតែបង្ហាញ `[]` ជា JSON ជំនួស `404 <!DOCTYPE...`។
