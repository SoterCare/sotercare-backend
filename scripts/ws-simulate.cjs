const { io } = require("socket.io-client");

const SERVER_URL = process.env.WS_SERVER_URL || "http://localhost:3000/realtime";
const DEVICE_ID = process.env.SOTERCARE_DEVICE_ID || process.env.DEVICE_ID || "pi-ffc585939c23";
const DEVICE_KEY = process.env.SOTERCARE_DEVICE_KEY || process.env.DEVICE_KEY;

if (!DEVICE_KEY) {
  console.error("Missing device key: set SOTERCARE_DEVICE_KEY (or DEVICE_KEY) in your shell. Never commit it.");
  process.exit(1);
}

const socket = io(SERVER_URL, {
  transports: ["websocket"],
  timeout: 10000,
});

const timeout = setTimeout(() => {
  console.error("timeout: no completion within 20s");
  socket.close();
  process.exit(1);
}, 20000);

socket.on("connect", () => {
  console.log("connected", socket.id);

  socket.emit(
    "device_auth",
    {
      device_id: DEVICE_ID,
      device_key: DEVICE_KEY,
      timestamp: Date.now(),
    },
    (authAck) => {
      console.log("authAck:", authAck);

      socket.emit(
        "device_data",
        {
          realtime_only: true,
          logs: [
            {
              temp: 36.5,
              ambientTemp: 24.2,
              moisture: 450,
              gait_label: "walking",
              sos_trigger: false,
              thighnode_status: "ble",
              fall_alert: false,
              unix_timestamp: Math.floor(Date.now() / 1000),
            },
          ],
        },
        (dataAck) => {
          console.log("dataAck:", dataAck);
          clearTimeout(timeout);
          socket.close();
          process.exit(0);
        },
      );
    },
  );
});

socket.on("exception", (e) => {
  console.error("ws exception:", e);
});

socket.on("connect_error", (e) => {
  console.error("connect_error:", e.message);
});
