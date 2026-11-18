// TypeORM CLI data source (AR-0). Usage after `npm run build:api`:
//   npm run migration:show | migration:run | migration:revert
// Connection settings come from the same env vars as the app.
import 'reflect-metadata';
import { DataSource, DataSourceOptions } from 'typeorm';
import {
  Alert,
  Device,
  DeviceOwnership,
  DeviceStatus,
  RecordingSession,
  SyncHistory,
  Vital,
} from './entities';
import { IotDevice } from '../iot-device/iot-device.entity';
import { buildTypeOrmOptions } from './typeorm-options';

const env = { get: (key: string, fallback?: string) => process.env[key] ?? fallback };
const base = buildTypeOrmOptions(env as never) as DataSourceOptions & {
  autoLoadEntities?: boolean;
};
delete base.autoLoadEntities;

export default new DataSource({
  ...base,
  synchronize: false,
  migrationsRun: false,
  entities: [Alert, Device, DeviceOwnership, DeviceStatus, RecordingSession, SyncHistory, Vital, IotDevice],
});
