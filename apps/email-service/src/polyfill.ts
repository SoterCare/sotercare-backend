import * as crypto from 'crypto';

// Polyfill for TypeORM/NestJS requiring global crypto in Node 18
if (!(global as any).crypto) {
    (global as any).crypto = crypto;
}
