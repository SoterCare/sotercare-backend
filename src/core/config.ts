export interface AppConfig {
  env: 'development' | 'test' | 'production';
  region: string;
  port: number;
  controlDatabaseUrl?: string;
  redisUrl?: string;
}

const ENVS = ['development', 'test', 'production'];

export function loadConfig(e: NodeJS.ProcessEnv = process.env): AppConfig {
  const env = (e.NODE_ENV ?? 'development') as AppConfig['env'];
  if (!ENVS.includes(env)) throw new Error(`Invalid NODE_ENV: ${env}`);
  const port = Number(e.PORT ?? 3000);
  if (!Number.isInteger(port) || port <= 0) throw new Error('Invalid PORT');
  return {
    env,
    region: e.AWS_REGION ?? 'ap-south-1',
    port,
    controlDatabaseUrl: e.CONTROL_DB_URL ?? e.CONTROL_DATABASE_URL,
    redisUrl: e.REDIS_URL,
  };
}
