interface VitalLog {
  heartRate?: number | null;
  spo2?: number | null;
  temperature?: number | null;
  sos?: boolean | null;
  fallAlert?: boolean | null;
  timestamp: string | number;
  [key: string]: unknown;
}

export function isCritical(log: VitalLog): boolean {
  return (
    log.sos === true ||
    log.fallAlert === true ||
    (log.spo2 != null && log.spo2 < 92) ||
    (log.heartRate != null && (log.heartRate > 120 || log.heartRate < 45)) ||
    (log.temperature != null && (log.temperature > 38.0 || log.temperature < 35.5))
  );
}

export function prepareLogs(logs: VitalLog[], maxLogs = 200): VitalLog[] {
  const critical = logs.filter(isCritical);
  const normal   = logs.filter(l => !isCritical(l));
  const budget   = maxLogs - critical.length;

  let sampled: VitalLog[];
  if (budget <= 0) {
    sampled = [];
  } else if (normal.length <= budget) {
    sampled = normal;
  } else {
    const step = Math.ceil(normal.length / budget);
    sampled = normal.filter((_, i) => i % step === 0);
  }

  return [...critical, ...sampled].sort(
    (a, b) => Number(a.timestamp) - Number(b.timestamp),
  );
}
