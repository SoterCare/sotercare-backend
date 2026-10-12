import { DeviceOwnerships1760500000001 } from './1760500000001-DeviceOwnerships';
import { AlertDispatch1760500000002 } from './1760500000002-AlertDispatch';
import { AlertAckAudit1760500000003 } from './1760500000003-AlertAckAudit';
import { AlertEpisodes1760500000004 } from './1760500000004-AlertEpisodes';
import { DeviceEvents1760500000005 } from './1760500000005-DeviceEvents';
import { PushNotifications1760500000006 } from './1760500000006-PushNotifications';

// AR-0: explicit, reviewable, ordered migration list (no glob — works with the
// tsc build). Every migration is additive and idempotent.
export const ALL_MIGRATIONS = [
  DeviceOwnerships1760500000001,
  AlertDispatch1760500000002,
  AlertAckAudit1760500000003,
  AlertEpisodes1760500000004,
  DeviceEvents1760500000005,
  PushNotifications1760500000006,
];
