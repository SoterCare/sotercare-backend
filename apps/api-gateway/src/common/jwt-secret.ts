import { createHash } from 'crypto';

// SHA-256 digests of JWT secrets that are public because they were committed
// to git history (the old hard-coded fallback). The values are deliberately not
// stored here. Any token signed with them must be treated as forgeable.
const KNOWN_PUBLIC_SECRET_SHA256 = new Set<string>([
  '4cac9eaf4f5835a64d77390e1f675c9b18df2159892ba0ecef3b820042000356',
  // Placeholder left in history once the real value was scrubbed from it.
  '2bfa2a6fa8724471b3bf26369afb9455a94d4f4657bb7aa0260d1657c9d27ca2',
]);

const MIN_PRODUCTION_SECRET_LENGTH = 32;

// Fail fast at boot: a missing, publicly known, or (in production) short
// JWT_SECRET would make tokens forgeable. Kept in sync with the copy in the
// other app that signs/verifies JWTs (api-gateway <-> auth-service).
export function requireJwtSecret(
  env: Record<string, string | undefined> = process.env,
): string {
  const secret = env.JWT_SECRET;
  if (!secret) {
    throw new Error('JWT_SECRET environment variable must be set');
  }
  const digest = createHash('sha256').update(secret).digest('hex');
  if (KNOWN_PUBLIC_SECRET_SHA256.has(digest)) {
    throw new Error('JWT_SECRET is a publicly known value; rotate it');
  }
  if (
    env.NODE_ENV === 'production' &&
    secret.length < MIN_PRODUCTION_SECRET_LENGTH
  ) {
    throw new Error(
      `JWT_SECRET must be at least ${MIN_PRODUCTION_SECRET_LENGTH} characters in production`,
    );
  }
  return secret;
}
