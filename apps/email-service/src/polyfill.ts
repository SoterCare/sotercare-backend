import * as crypto from 'crypto';

// Only set global crypto when missing (Node 20+ already defines a getter-backed global crypto).
const globalWithCrypto = global as unknown as { crypto?: unknown };
if (!globalWithCrypto.crypto) {
  globalWithCrypto.crypto = crypto;
}
