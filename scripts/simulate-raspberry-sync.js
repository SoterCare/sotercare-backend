const fs = require('fs');
const path = require('path');

const apiUrl = process.env.SIM_API_URL || 'http://localhost:3000/logs/raspberry/sync';
const apiKey = process.env.RASPBERRY_API_KEY || '';
const userId = Number(process.env.SIM_USER_ID || 1);
const batchSize = Number(process.env.SIM_BATCH_SIZE || 200);
const delayMs = Number(process.env.SIM_DELAY_MS || 50);
const dryRun = process.env.SIM_DRY_RUN === '1';
const samplePath =
  process.env.SIM_FILE_PATH || path.join(process.cwd(), '3days-sample.json');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function ensureValidConfig() {
  if (!Number.isFinite(userId) || userId <= 0) {
    throw new Error('SIM_USER_ID must be a positive number.');
  }

  if (!Number.isFinite(batchSize) || batchSize <= 0) {
    throw new Error('SIM_BATCH_SIZE must be a positive number.');
  }
}

async function sendBatch(logs, batchIndex, totalBatches) {
  const payload = {
    user_id: userId,
    logs,
  };

  if (dryRun) {
    console.log(
      `[DRY RUN] Batch ${batchIndex}/${totalBatches}: ${logs.length} logs prepared`,
    );
    return { success: true, syncedCount: logs.length };
  }

  const headers = {
    'Content-Type': 'application/json',
  };

  if (apiKey) {
    headers['x-raspberry-key'] = apiKey;
  }

  const response = await fetch(apiUrl, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
  });

  const text = await response.text();
  let body;

  try {
    body = JSON.parse(text);
  } catch {
    body = { raw: text };
  }

  if (!response.ok) {
    throw new Error(
      `Batch ${batchIndex}/${totalBatches} failed with ${response.status}: ${JSON.stringify(body)}`,
    );
  }

  const syncedCount =
    Number(body?.syncedCount) || Number(body?.data?.syncedCount) || logs.length;

  console.log(
    `Batch ${batchIndex}/${totalBatches} synced: ${syncedCount}/${logs.length}`,
  );

  return { success: true, syncedCount };
}

async function main() {
  ensureValidConfig();

  if (!fs.existsSync(samplePath)) {
    throw new Error(`Sample file not found: ${samplePath}`);
  }

  const raw = fs.readFileSync(samplePath, 'utf8');
  const parsed = JSON.parse(raw);

  if (!parsed || !Array.isArray(parsed.logs)) {
    throw new Error('Invalid sample format: expected object with a logs array.');
  }

  const allLogs = parsed.logs;
  const totalBatches = Math.ceil(allLogs.length / batchSize);
  let totalSynced = 0;

  console.log(`Source file: ${samplePath}`);
  console.log(`Target URL: ${apiUrl}`);
  console.log(`Logs: ${allLogs.length}`);
  console.log(`Batch size: ${batchSize}`);
  console.log(`Batches: ${totalBatches}`);
  console.log(`User ID: ${userId}`);
  console.log(`Dry run: ${dryRun ? 'yes' : 'no'}`);

  for (let index = 0; index < allLogs.length; index += batchSize) {
    const chunk = allLogs.slice(index, index + batchSize);
    const batchIndex = Math.floor(index / batchSize) + 1;

    const result = await sendBatch(chunk, batchIndex, totalBatches);
    totalSynced += result.syncedCount;

    if (!dryRun && batchIndex < totalBatches && delayMs > 0) {
      await sleep(delayMs);
    }
  }

  console.log('Simulation completed successfully.');
  console.log(`Total synced logs: ${totalSynced}/${allLogs.length}`);
}

main().catch((error) => {
  console.error('Simulation failed.');
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
