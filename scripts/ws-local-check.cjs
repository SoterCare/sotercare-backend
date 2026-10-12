const { io } = require("socket.io-client");
const http = require("http");

// Credentials come from the environment -- never commit them.
//   SOTERCARE_TEST_JWT   (required) user JWT issued by your LOCAL backend (alias USER_TOKEN)
//   SOTERCARE_DEVICE_KEY (required) device key registered on your LOCAL backend (alias DEVICE_KEY)
//   SOTERCARE_DEVICE_ID  (optional) default pi-ffc585939c23 (alias DEVICE_ID)
const JWT = process.env.SOTERCARE_TEST_JWT || process.env.USER_TOKEN;
const DEVICE_ID = process.env.SOTERCARE_DEVICE_ID || process.env.DEVICE_ID || "pi-ffc585939c23";
const DEVICE_KEY = process.env.SOTERCARE_DEVICE_KEY || process.env.DEVICE_KEY;

if (!JWT || !DEVICE_KEY) {
  console.error("Missing credentials: set SOTERCARE_TEST_JWT and SOTERCARE_DEVICE_KEY in your shell. Never commit them.");
  process.exit(1);
}

const socket = io("http://localhost:3000/realtime");

let count = 0;

function queryAPI(path, name) {
  return new Promise((resolve, reject) => {
    const opts = {
      headers: { Authorization: `Bearer ${JWT}`, accept: "*/*" }
    };
    http.get(`http://localhost:3000${path}`, opts, (res) => {
      let data = "";
      res.on("data", chunk => data += chunk);
      res.on("end", () => {
        try {
          resolve({ name, data: JSON.parse(data) });
        } catch (e) {
          resolve({ name, data: data });
        }
      });
    }).on("error", reject);
  });
}

async function verifyAllEndpoints() {
  console.log("\n=== VERIFYING ALL TIMELINE ENDPOINTS ===");

  const results = await Promise.all([
    queryAPI("/timeline/vitals?deviceId=pi-ffc585939c23&metric=temp&period=day&date=2026-03-20", "Vitals (Temp)"),
    queryAPI("/timeline/vitals?deviceId=pi-ffc585939c23&metric=gait&period=day&date=2026-03-20", "Vitals (Gait)"),
    queryAPI("/timeline/events?deviceId=pi-ffc585939c23&period=day&date=2026-03-20&filter=all", "Events"),
    queryAPI("/timeline/stats?deviceId=pi-ffc585939c23&period=day&date=2026-03-20&month=2026-03", "Stats")
  ]);

  for (const { name, data } of results) {
    console.log(`\n--- ${name} ---`);
    if (data && data.data && data.data.points) {
      const nonNull = data.data.points.filter(p => p.value !== null);
      console.log("Non-null buckets:", JSON.stringify(nonNull, null, 2));
    } else {
      console.log(JSON.stringify(data.data || data, null, 2));
    }
  }

  process.exit(0);
}

socket.on("connect", () => {
  console.log("✅ Connected to LOCAL backend");

  socket.emit("device_auth", {
    device_id: DEVICE_ID,
    device_key: DEVICE_KEY,
    timestamp: Date.now(),
  }, (authAck) => {
    if (authAck && authAck.status === "error") {
      console.error("Auth failed:", authAck.message);
      process.exit(1);
    }

    const scenarios = [
      { temp: 36.5, ambientTemp: 24.2, moisture: 450, gait_label: "walking",  sos_trigger: false, thighnode_status: "ble", fall_alert: false },
      { temp: 37.1, ambientTemp: 23.8, moisture: 320, gait_label: "standing", sos_trigger: false, thighnode_status: "ble", fall_alert: false },
      { temp: 36.8, ambientTemp: 24.0, moisture: 510, gait_label: "sitting",  sos_trigger: true,  thighnode_status: "ble", fall_alert: false },  // SOS!
      { temp: 37.4, ambientTemp: 25.1, moisture: 480, gait_label: "walking",  sos_trigger: false, thighnode_status: "ble", fall_alert: true  },  // FALL!
    ];

    const interval = setInterval(() => {
      if (count >= scenarios.length) {
        clearInterval(interval);
        console.log(`\n✅ Sent ${scenarios.length} logs. Querying timeline APIs...`);
        setTimeout(verifyAllEndpoints, 1000);
        return;
      }

      const logEntry = {
        ...scenarios[count],
        unix_timestamp: Math.floor(Date.now() / 1000),
      };

      socket.emit("device_data", { logs: [logEntry] });
      console.log(`Sent log: ${logEntry.gait_label} (sos: ${logEntry.sos_trigger}, fall: ${logEntry.fall_alert})`);
      count++;
    }, 500);
  });
});
