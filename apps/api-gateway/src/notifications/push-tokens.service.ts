import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { rowsOf } from './db-rows';
import { RegisterPushTokenDto } from './dto/register-push-token.dto';

/** `ExponentPushToken[abcd…wxyz]`: enough to tell phones apart, not to use. */
export function maskToken(token: string): string {
  const m = /^(Expo(?:nent)?PushToken)\[(.*)\]$/.exec(token);
  if (!m) return '…';
  const inner = m[2];
  return inner.length > 8
    ? `${m[1]}[${inner.slice(0, 4)}…${inner.slice(-4)}]`
    : `${m[1]}[…]`;
}

/**
 * AR-6 token lifecycle. A token is bound to one user at a time: registering
 * it again from another account moves it (possession of the token is control
 * of that app installation), and a new token for the same installation
 * replaces the old one. Tokens are revoked, never deleted.
 */
@Injectable()
export class PushTokensService {
  private readonly logger = new Logger(PushTokensService.name);

  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  async register(userId: number, dto: RegisterPushTokenDto) {
    return this.dataSource.transaction(async (manager) => {
      const [previous] = rowsOf<{ id: string; userId: number }>(
        await manager.query(
          `SELECT id, "userId" FROM push_tokens WHERE token = $1 FOR UPDATE`,
          [dto.token],
        ),
      );
      const [row] = rowsOf<{ id: string; createdAt: Date }>(
        await manager.query(
          `INSERT INTO push_tokens ("userId", token, platform, "installationId", "appVersion", permission)
           VALUES ($1, $2, $3, $4, $5, $6)
           ON CONFLICT (token) DO UPDATE SET
             "userId" = EXCLUDED."userId", platform = EXCLUDED.platform,
             "installationId" = EXCLUDED."installationId", "appVersion" = EXCLUDED."appVersion",
             permission = EXCLUDED.permission, "lastSeenAt" = now(),
             "revokedAt" = NULL, "revokedReason" = NULL
           RETURNING id, "createdAt"`,
          [
            userId,
            dto.token,
            dto.platform,
            dto.installationId,
            dto.appVersion ?? null,
            dto.permission ?? null,
          ],
        ),
      );
      await manager.query(
        `UPDATE push_tokens SET "revokedAt" = now(), "revokedReason" = 'replaced'
         WHERE "userId" = $1 AND "installationId" = $2 AND id <> $3 AND "revokedAt" IS NULL`,
        [userId, dto.installationId, row.id],
      );
      if (previous && previous.userId !== userId) {
        this.logger.log(
          `push token ${row.id} reassigned from user ${previous.userId} to user ${userId}`,
        );
      }
      return { id: String(row.id), registeredAt: row.createdAt };
    });
  }

  async revokeInstallation(userId: number, installationId: string) {
    const rows = rowsOf<{ id: string }>(
      await this.dataSource.query(
        `UPDATE push_tokens SET "revokedAt" = now(), "revokedReason" = 'logout'
         WHERE "userId" = $1 AND "installationId" = $2 AND "revokedAt" IS NULL
         RETURNING id`,
        [userId, installationId],
      ),
    );
    return { revoked: rows.length };
  }

  async listActive(userId: number) {
    const rows = rowsOf<{
      id: string;
      token: string;
      platform: string;
      installationId: string;
      appVersion: string | null;
      createdAt: Date;
      lastSeenAt: Date;
    }>(
      await this.dataSource.query(
        `SELECT id, token, platform, "installationId", "appVersion", "createdAt", "lastSeenAt"
         FROM push_tokens WHERE "userId" = $1 AND "revokedAt" IS NULL ORDER BY id`,
        [userId],
      ),
    );
    return rows.map(({ token, ...rest }) => ({
      ...rest,
      id: String(rest.id),
      token: maskToken(token),
    }));
  }

  async status(userId: number) {
    const [row] = rowsOf<{ n: number }>(
      await this.dataSource.query(
        `SELECT count(*)::int n FROM push_tokens WHERE "userId" = $1 AND "revokedAt" IS NULL`,
        [userId],
      ),
    );
    return { activeTokens: row.n };
  }
}
