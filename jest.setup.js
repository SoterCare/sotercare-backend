// Jest global setup — provides deterministic env for unit tests so that
// production boot-guards (e.g. requireJwtSecret) don't trip during testing.
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
process.env.NODE_ENV = process.env.NODE_ENV || 'test';
