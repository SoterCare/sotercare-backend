/**
 * ws-prod-check.cjs
 *
 * End-to-end WebSocket smoke-test for the SoterCare edge-gateway flow.
 * Sends a sequenced set of sensor payloads through the /realtime namespace
 * and reports what alerts each one should trigger.
 *
 * Usage:
 *   node scripts/ws-prod-check.cjs
 *
 * Override defaults via environment variables:
 *   WS_URL      WebSocket base URL  (default: wss://backend.sotercare.com)
 *   DEVICE_ID   Device ID           (default: pi-ffc585939c23)
 *   DEVICE_KEY  Device secret key   (default: see below)
 *   USER_TOKEN  JWT bearer token — if set, opens a second socket as a user
 *               so alert.new / device.logs.ingested events are printed live
 *   INTERVAL_MS Milliseconds between sends (default: 1500)
 */

"use strict";

const { io } = require("socket.io-client");

// ─── Config ──────────────────────────────────────────────────────────────────

const WS_BASE     = process.env.WS_URL      || "wss://backend.sotercare.com";
const DEVICE_ID   = process.env.DEVICE_ID   || "pi-ffc585939c23";
const DEVICE_KEY  = process.env.DEVICE_KEY  || "TW3DNioQHndfvbcIyVex2KqBCJFwjZuOpPsEYa15";
const USER_TOKEN  = process.env.USER_TOKEN  || "";
const INTERVAL_MS = Number(process.env.INTERVAL_MS) || 1500;

// ─── Alert threshold reference (keep in sync with backend) ───────────────────
//
// NestJS AlertWriterService  (fires immediately on device_data):
//   moisture >= 25           → MOISTURE  "Moisture Detected"
//   sos == true              → HELP_CALL "Help Call"
//   fall_alert == true       → FALL      "Fall Detected"
//
// Python Safety Guard        (polled every ~10 s from vital_sign table):
//   temperature > 38.0 °C   → TEMPERATURE "Fever detected"
//   temperature < 35.5 °C   → TEMPERATURE "Low temperature"
//   moisture > 80            → MOISTURE  "High moisture"
//   moisture < 15            → MOISTURE  "Low moisture"
//   spo2 / heartRate: NOT SENT by this device — no sensor attached.

// ─── Test scenarios ───────────────────────────────────────────────────────────

const SCENARIOS = [
  {
    label: "Baseline — normal vitals, no alerts",
    expect: "none",
    data: {
      temperature: 36.6,
      ambientTemp: 24.0,
      moisture: 10,
      gait_label: "walking",
      sos: false,
      fall_alert: false,
      thighnode_status: "connected",
    },
  },
  {
    label: "Slight moisture rise — still below threshold",
    expect: "none",
    data: {
      temperature: 36.7,
      ambientTemp: 24.2,
      moisture: 20,
      gait_label: "standing",
      sos: false,
      fall_alert: false,
      thighnode_status: "connected",
    },
  },
  {
    label: "Moisture spike — MOISTURE alert (moisture=55 >= 25)",
    expect: "MOISTURE",
    data: {
      temperature: 36.8,
      ambientTemp: 24.5,
      moisture: 55,
      gait_label: "sitting down",
      sos: false,
      fall_alert: false,
      thighnode_status: "connected",
    },
  },
  {
    label: "SOS button pressed — HELP_CALL alert",
    expect: "HELP_CALL",
    data: {
      temperature: 36.7,
      ambientTemp: 23.8,
      moisture: 12,
      gait_label: "lying down",
      sos: true,
      fall_alert: false,
      thighnode_status: "connected",
    },
  },
  {
    label: "Fall detected — FALL alert",
    expect: "FALL",
    data: {
      temperature: 36.6,
      ambientTemp: 24.1,
      moisture: 8,
      gait_label: "lying down",
      sos: false,
      fall_alert: true,
      thighnode_status: "connected",
    },
  },
  {
    label: "SOS + Fall + high moisture simultaneously — HELP_CALL + FALL + MOISTURE",
    expect: "HELP_CALL, FALL, MOISTURE",
    data: {
      temperature: 36.9,
      ambientTemp: 24.0,
      moisture: 80,
      gait_label: "lying down",
      sos: true,
      fall_alert: true,
      thighnode_status: "connected",
    },
  },
  {
    label: "Fever — safety guard TEMPERATURE alert (temp=38.6 > 38.0, fires within ~10 s)",
    expect: "TEMPERATURE (safety guard, delayed)",
    data: {
      temperature: 38.6,
      ambientTemp: 25.0,
      moisture: 18,
      gait_label: "lying down",
      sos: false,
      fall_alert: false,
      thighnode_status: "connected",
    },
  },
  {
    label: "Low temperature — safety guard TEMPERATURE alert (temp=35.2 < 35.5)",
    expect: "TEMPERATURE (safety guard, delayed)",
    data: {
      temperature: 35.2,
      ambientTemp: 22.0,
      moisture: 5,
      gait_label: "walking",
      sos: false,
      fall_alert: false,
      thighnode_status: "connected",
    },
  },
  {
    label: "Thighnode disconnected — stored in vitals, no alert",
    expect: "none",
    data: {
      temperature: 36.6,
      ambientTemp: 24.0,
      moisture: 14,
      gait_label: "N/A",
      sos: false,
      fall_alert: false,
      thighnode_status: "disconnected",
    },
  },
  {
    label: "Back to baseline — normal vitals, no alerts",
    expect: "none",
    data: {
      temperature: 36.7,
      ambientTemp: 24.3,
      moisture: 11,
      gait_label: "walking",
      sos: false,
      fall_alert: false,
      thighnode_status: "connected",
    },
  },
];

// ─── User socket (optional) — receives alert.new / device.logs.ingested ──────

if (USER_TOKEN) {
  const userSocket = io(`${WS_BASE}/realtime`, {
    transports: ["websocket"],
    auth: { token: USER_TOKEN },
  });

  userSocket.on("connect", () => console.log("[USER SOCKET] Connected — listening for events"));

  userSocket.on("alert.new", (alert) => {
    console.log("\n  ┌─ alert.new ─────────────────────────────");
    console.log(`  │  type=${alert.type}  title="${alert.title}"`);
    console.log(`  │  id=${alert.id}  device=${alert.deviceId}`);
    console.log("  └─────────────────────────────────────────");
  });

  userSocket.on("device.logs.ingested", (evt) => {
    const t = evt.latest || (Array.isArray(evt.logs) && evt.logs[evt.logs.length - 1]);
    if (t) {
      console.log(
        `  [ingested] temp=${t.temperature}°C  moisture=${t.moisture}` +
        `  gait="${t.gait_label}"  sos=${t.sos}  fall=${t.fall_alert}`
      );
    }
  });

  userSocket.on("connect_error", (e) => console.warn("[USER SOCKET] connect_error:", e.message));
}

// ─── Device socket ────────────────────────────────────────────────────────────

const deviceSocket = io(`${WS_BASE}/realtime`, { transports: ["websocket"] });

let step = 0;
let interval;

deviceSocket.on("connect", () => {
  console.log(`\n[DEVICE] Connected to ${WS_BASE}/realtime`);
  console.log(`[DEVICE] Authenticating as ${DEVICE_ID} ...`);

  deviceSocket.emit(
    "device_auth",
    { device_id: DEVICE_ID, device_key: DEVICE_KEY, timestamp: Date.now() },
    (ack) => {
      if (!ack?.success) {
        console.error("[AUTH] FAILED:", JSON.stringify(ack));
        deviceSocket.close();
        process.exit(1);
      }
      console.log(`[AUTH] OK — owner_id=${ack.owner_id}`);
      console.log(`\nRunning ${SCENARIOS.length} scenarios every ${INTERVAL_MS} ms...\n`);

      interval = setInterval(() => {
        if (step >= SCENARIOS.length) {
          console.log("\n[DONE] All scenarios sent.");
          clearInterval(interval);
          deviceSocket.close();
          process.exit(0);
          return;
        }

        const scenario = SCENARIOS[step];
        const payload = {
          ...scenario.data,
          unix_timestamp: Date.now(), // epoch ms; gateway normalises seconds too
        };

        const pad = (n) => String(n + 1).padStart(2, " ");
        console.log(`[${pad(step)}/${SCENARIOS.length}] ${scenario.label}`);
        console.log(`         expect: ${scenario.expect}`);
        console.log(`         payload: ${JSON.stringify(payload)}`);

        deviceSocket.emit("device_data", { logs: [payload] }, (dataAck) => {
          if (dataAck?.success) {
            const synced = dataAck.synced?.synced_count ?? JSON.stringify(dataAck.synced);
            console.log(`         ack: OK  synced_count=${synced}`);
          } else {
            console.error("         ack: ERROR —", JSON.stringify(dataAck));
          }
        });

        step++;
      }, INTERVAL_MS);
    }
  );
});

deviceSocket.on("exception",     (e) => console.error("[WS exception]",     JSON.stringify(e)));
deviceSocket.on("connect_error", (e) => console.error("[connect_error]",    e.message));
deviceSocket.on("disconnect",    (r) => console.log( "[DEVICE] Disconnected:", r));
