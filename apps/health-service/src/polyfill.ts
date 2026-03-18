import * as crypto from 'crypto';

// Only set global crypto when missing (Node 20+ already defines a getter-backed global crypto).
if (!(global as any).crypto) {
  (global as any).crypto = crypto;
}
