/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return */
import { Client } from 'pg';

type DeviceSeed = {
  id: string;
  name: string;
  type: 'hub' | 'thigh_band' | 'wrist_band';
};

const devices: DeviceSeed[] = [
  { id: 'hub-room-01', name: 'Room Hub 01', type: 'hub' },
  { id: 'band-thigh-01', name: 'Thigh Band 01', type: 'thigh_band' },
];

const alertTypes = [
  'movement',
  'fall',
  'urine',
  'temperature',
  'moisture',
] as const;

function isoSlot(value: Date): string {
  return value.toISOString().replace(/[:.]/g, '-');
}

function addMinutes(base: Date, minutes: number): Date {
  return new Date(base.getTime() + minutes * 60_000);
}

function toFixedNumber(value: number, digits = 1): number {
  return Number(value.toFixed(digits));
}

async function ensureUser(client: Client): Promise<number> {
  const email = process.env.SEED_USER_EMAIL ?? 'elder.demo@example.com';
  const name = process.env.SEED_USER_NAME ?? 'Elder Demo';
  const mobileNumber = process.env.SEED_USER_MOBILE ?? '+94770000000';

  const existing = await client.query<{ id: number }>(
    'SELECT id FROM "user" WHERE email = $1 LIMIT 1',
    [email],
  );

  if (existing.rowCount) {
    await client.query(
      'UPDATE "user" SET name = $2, "mobileNumber" = $3 WHERE id = $1',
      [existing.rows[0].id, name, mobileNumber],
    );
    return existing.rows[0].id;
  }

  const created = await client.query<{ id: number }>(
    'INSERT INTO "user" (email, name, "mobileNumber") VALUES ($1, $2, $3) RETURNING id',
    [email, name, mobileNumber],
  );

  return created.rows[0].id;
}

async function seedDevices(
  client: Client,
  userId: number,
  syncedAt: Date,
  slot: string,
): Promise<void> {
  for (const device of devices) {
    await client.query(
      `INSERT INTO devices (id, "userId", name, type, "lastSeenAt", "lastSyncSlot", "syncSource")
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (id) DO UPDATE
       SET "userId" = EXCLUDED."userId",
           name = EXCLUDED.name,
           type = EXCLUDED.type,
           "lastSeenAt" = EXCLUDED."lastSeenAt",
           "lastSyncSlot" = EXCLUDED."lastSyncSlot",
           "syncSource" = EXCLUDED."syncSource",
           "updatedAt" = NOW()`,
      [
        device.id,
        userId,
        device.name,
        device.type,
        syncedAt,
        slot,
        'seed_script',
      ],
    );
  }
}

async function seedStatuses(client: Client, syncedAt: Date): Promise<void> {
  const statuses = [
    {
      deviceId: 'hub-room-01',
      battery: 91,
      signalRssi: -44,
      connectedAt: addMinutes(syncedAt, -90),
      bands: [
        { name: 'Thigh Band 01', status: 'connected' },
        { name: 'Wrist Band 02', status: 'idle' },
      ],
    },
    {
      deviceId: 'band-thigh-01',
      battery: 76,
      signalRssi: -61,
      connectedAt: addMinutes(syncedAt, -55),
      bands: [{ name: 'Room Hub 01', status: 'connected' }],
    },
  ];

  for (const status of statuses) {
    await client.query(
      `INSERT INTO device_statuses ("deviceId", battery, "signalRssi", "connectedAt", bands, "receivedAt")
       VALUES ($1, $2, $3, $4, $5::jsonb, $6)`,
      [
        status.deviceId,
        status.battery,
        status.signalRssi,
        status.connectedAt,
        JSON.stringify(status.bands),
        syncedAt,
      ],
    );
  }
}

async function seedVitals(client: Client, syncedAt: Date): Promise<number> {
  let inserted = 0;
  const start = addMinutes(syncedAt, -(48 * 60) + 15);

  for (let index = 0; index < 48 * 4; index += 1) {
    const timestamp = addMinutes(start, index * 15);
    const syncSlot = isoSlot(timestamp);

    const rows = [
      {
        deviceId: 'hub-room-01',
        temperature: toFixedNumber(36.3 + Math.sin(index / 12) * 0.6),
        roomTemperature: toFixedNumber(27.2 + Math.cos(index / 18) * 1.8),
        moisture: 45 + (index % 7),
        gaitAnalysis:
          index % 19 === 0 ? 'unstable gait detected' : 'normal gait',
      },
      {
        deviceId: 'band-thigh-01',
        temperature: toFixedNumber(36.1 + Math.sin(index / 10) * 0.4),
        roomTemperature: toFixedNumber(27.0 + Math.cos(index / 16) * 1.2),
        moisture: 40 + (index % 5),
        gaitAnalysis:
          index % 27 === 0 ? 'reduced stride length' : 'steady gait',
      },
    ];

    for (const row of rows) {
      const result = await client.query(
        `INSERT INTO vitals ("deviceId", timestamp, temperature, "roomTemperature", moisture, "gaitAnalysis", "syncSlot")
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT ("deviceId", timestamp) DO NOTHING`,
        [
          row.deviceId,
          timestamp,
          row.temperature,
          row.roomTemperature,
          row.moisture,
          row.gaitAnalysis,
          syncSlot,
        ],
      );

      inserted += result.rowCount ?? 0;
    }
  }

  return inserted;
}

async function seedAlerts(client: Client, syncedAt: Date): Promise<number> {
  let inserted = 0;

  for (let index = 0; index < 20; index += 1) {
    const timestamp = addMinutes(syncedAt, -(index + 1) * 35);
    const type = alertTypes[index % alertTypes.length];
    const id = `seed-alert-${String(index + 1).padStart(2, '0')}`;
    const deviceId = index % 2 === 0 ? 'hub-room-01' : 'band-thigh-01';

    const result = await client.query(
      `INSERT INTO alerts (id, "deviceId", type, title, timestamp, "isDismissed", "dismissedAt", "syncSlot")
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (id) DO NOTHING`,
      [
        id,
        deviceId,
        type,
        `${type.toUpperCase()} alert #${index + 1}`,
        timestamp,
        index % 6 === 0,
        index % 6 === 0 ? addMinutes(timestamp, 20) : null,
        isoSlot(timestamp),
      ],
    );

    inserted += result.rowCount ?? 0;
  }

  return inserted;
}

async function seedRecordings(client: Client, syncedAt: Date): Promise<number> {
  let inserted = 0;

  for (let index = 0; index < 3; index += 1) {
    const createdAt = addMinutes(syncedAt, -(index + 1) * 180);
    const result = await client.query(
      `INSERT INTO recording_sessions ("recordingId", "deviceId", "createdAt", "syncedAt")
       VALUES ($1, $2, $3, $4)
       ON CONFLICT ("recordingId") DO NOTHING`,
      [
        `seed-recording-${index + 1}`,
        index % 2 === 0 ? 'hub-room-01' : 'band-thigh-01',
        createdAt,
        syncedAt,
      ],
    );

    inserted += result.rowCount ?? 0;
  }

  return inserted;
}

async function seedSyncHistory(
  client: Client,
  userId: number,
  syncedAt: Date,
  slot: string,
): Promise<void> {
  const idempotencyKey = `mobile_sync_${slot}_${syncedAt.toISOString()}`;

  await client.query(
    `INSERT INTO sync_history ("userId", source, slot, "syncedAt", "gatewayHost", "upsertSummary", "idempotencyKey")
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)
     ON CONFLICT ("idempotencyKey") DO UPDATE
     SET "upsertSummary" = EXCLUDED."upsertSummary",
         "gatewayHost" = EXCLUDED."gatewayHost",
         "syncedAt" = EXCLUDED."syncedAt"`,
    [
      userId,
      'mobile_sync',
      slot,
      syncedAt,
      process.env.SEED_GATEWAY_HOST ?? 'seed-script',
      JSON.stringify({
        devices: 2,
        statuses: 2,
        vitals: 384,
        alerts: 20,
        recordings: 3,
      }),
      idempotencyKey,
    ],
  );
}

async function main(): Promise<void> {
  const client = new Client({
    host: process.env.DB_HOST ?? 'localhost',
    port: Number(process.env.DB_PORT ?? 5432),
    user: process.env.DB_USER ?? 'postgres',
    password: process.env.DB_PASS ?? 'postgres',
    database: process.env.DB_NAME ?? 'auth_db',
  });

  await client.connect();

  try {
    const syncedAt = new Date();
    const slot = isoSlot(syncedAt);
    const userId = await ensureUser(client);

    await seedDevices(client, userId, syncedAt, slot);
    await seedStatuses(client, syncedAt);
    const vitals = await seedVitals(client, syncedAt);
    const alerts = await seedAlerts(client, syncedAt);
    const recordings = await seedRecordings(client, syncedAt);
    await seedSyncHistory(client, userId, syncedAt, slot);

    console.log('Seed completed successfully.');
    console.log(
      JSON.stringify(
        {
          userId,
          devices: devices.length,
          statuses: 2,
          vitals,
          alerts,
          recordings,
          syncHistory: 1,
        },
        null,
        2,
      ),
    );
  } finally {
    await client.end();
  }
}

main().catch((error: unknown) => {
  console.error('Seed failed.', error);
  process.exit(1);
});
