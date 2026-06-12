import {
  ConnectedSocket,
  MessageBody,
  OnGatewayInit,
  OnGatewayConnection,
  OnGatewayDisconnect,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
  WsException,
} from '@nestjs/websockets';
import { HttpException, Inject, Logger } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import type { ClientGrpc } from '@nestjs/microservices';
import { lastValueFrom, timeout, type Observable } from 'rxjs';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Server, Socket } from 'socket.io';
import { Alert, Vital } from '../database/entities';
import { IotDeviceService } from '../iot-device/iot-device.service';
import { SyncBatchDto } from '../sync/dto/sync-batch.dto';
import { SyncService } from '../sync/sync.service';
import { AlertWriterService } from './alert-writer.service';

interface HealthService {
  syncLogs(data: unknown): Observable<unknown>;
}

type JwtPayload = {
  userId?: number | string;
};

type RealtimeSocketData = {
  userId?: number;
  deviceId?: string;
  ownerId?: number;
};

// Cap how long we'll wait on the health-service so a hung gRPC dependency
// can't stall the socket handler indefinitely.
const SYNC_LOGS_TIMEOUT_MS = 10000;

type NormalizedGrpcLog = {
  id: number;
  temperature: number;
  ambient_temp?: number;
  moisture?: number;
  gait_label: string;
  sos: boolean;
  thighnode_status: string;
  fall_alert: boolean;
  heart_rate?: number;
  spo2?: number;
  device_id: string;
  timestamp: number;
};

@WebSocketGateway({
  namespace: '/realtime',
  cors: {
    origin: '*',
  },
})
export class RealtimeGateway
  implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect
{
  @WebSocketServer()
  server: Server;

  private healthService: HealthService;
  private readonly logger = new Logger(RealtimeGateway.name);

  private readonly userSockets = new Map<number, Set<string>>();
  private readonly deviceSockets = new Map<string, string>();
  private readonly maxClockSkewMs = Number(
    process.env.IOT_MAX_CLOCK_SKEW_MS || 15 * 60 * 1000,
  );

  constructor(
    @Inject('HEALTH_SERVICE') private readonly healthClient: ClientGrpc,
    private readonly jwtService: JwtService,
    private readonly iotDeviceService: IotDeviceService,
    private readonly syncService: SyncService,
    private readonly alertWriterService: AlertWriterService,
    @InjectRepository(Vital)
    private readonly vitalRepository: Repository<Vital>,
    @InjectRepository(Alert)
    private readonly alertRepository: Repository<Alert>,
  ) {}

  afterInit() {
    this.healthService =
      this.healthClient.getService<HealthService>('HealthService');
  }

  private toWsException(error: unknown): WsException {
    if (error instanceof WsException) {
      return error;
    }

    if (error instanceof HttpException) {
      const response = error.getResponse();
      if (
        typeof response === 'object' &&
        response !== null &&
        'message' in response
      ) {
        const message = (response as { message?: unknown }).message;
        if (Array.isArray(message)) {
          return new WsException(message.join(', '));
        }
        if (typeof message === 'string' && message.length > 0) {
          return new WsException(message);
        }
      }

      return new WsException(error.message || 'Request failed');
    }

    if (error instanceof Error) {
      return new WsException(error.message || 'Internal server error');
    }

    return new WsException('Internal server error');
  }

  private toUnixMs(value: number | string | undefined): number {
    if (value === undefined || value === null) {
      return Date.now();
    }

    if (typeof value === 'number' && Number.isFinite(value)) {
      // Accept both unix seconds and unix milliseconds.
      return value < 1_000_000_000_000 ? value * 1000 : value;
    }

    const numeric = Number(value);
    if (!Number.isNaN(numeric) && Number.isFinite(numeric)) {
      return numeric < 1_000_000_000_000 ? numeric * 1000 : numeric;
    }

    const parsed = Date.parse(String(value));
    return Number.isNaN(parsed) ? Date.now() : parsed;
  }

  private toOptionalNumber(value: unknown): number | undefined {
    if (value === undefined || value === null) {
      return undefined;
    }
    const n = Number(value);
    return Number.isFinite(n) ? n : undefined;
  }

  async handleConnection(client: Socket) {
    const token =
      String(client.handshake.auth?.token || '') ||
      String(client.handshake.headers.authorization || '').replace(
        'Bearer ',
        '',
      );

    if (!token) {
      return;
    }

    try {
      const payload = await this.jwtService.verifyAsync<JwtPayload>(token, {
        // H2: require a real secret; no public 'REMOVED-OLD-PUBLIC-FALLBACK' fallback.
        secret: process.env.JWT_SECRET,
      });
      const userId = Number(payload.userId);
      if (!Number.isFinite(userId)) {
        return;
      }

      const existing = this.userSockets.get(userId) || new Set<string>();
      existing.add(client.id);
      this.userSockets.set(userId, existing);
      const data = client.data as RealtimeSocketData;
      data.userId = userId;
    } catch {
      // keep connection open for unauthenticated client types (device_auth event)
    }
  }

  handleDisconnect(client: Socket) {
    const data = client.data as RealtimeSocketData;
    const userId = Number(data.userId);
    if (Number.isFinite(userId)) {
      const set = this.userSockets.get(userId);
      if (set) {
        set.delete(client.id);
        if (set.size === 0) {
          this.userSockets.delete(userId);
        }
      }
    }

    for (const [deviceId, socketId] of this.deviceSockets.entries()) {
      if (socketId === client.id) {
        this.deviceSockets.delete(deviceId);
      }
    }
  }

  @SubscribeMessage('device_auth')
  async handleDeviceAuth(
    @ConnectedSocket() client: Socket,
    @MessageBody()
    body: {
      device_id: string;
      device_key: string;
      timestamp?: string | number;
    },
  ) {
    let result: { ownerId: number; deviceId: string };
    try {
      result = await this.iotDeviceService.authenticateAndResolveOwner(
        body.device_id,
        body.device_key,
      );
    } catch (error) {
      throw this.toWsException(error);
    }

    this.deviceSockets.set(result.deviceId, client.id);
    const data = client.data as RealtimeSocketData;
    data.deviceId = result.deviceId;
    data.ownerId = result.ownerId;

    return {
      success: true,
      device_id: result.deviceId,
      owner_id: result.ownerId,
    };
  }

  @SubscribeMessage('device_data')
  async handleDeviceData(
    @ConnectedSocket() client: Socket,
    @MessageBody()
    body: {
      device_id?: string;
      device_key?: string;
      logs?: Array<Record<string, unknown>>;
      payload?: Record<string, unknown>;
      realtime_only?: boolean;
    },
  ) {
    const logs =
      Array.isArray(body?.logs) && body.logs.length > 0
        ? body.logs
        : body?.payload && typeof body.payload === 'object'
          ? [body.payload]
          : [];
    if (logs.length === 0) {
      throw new WsException('logs are required');
    }

    const data = client.data as RealtimeSocketData;
    let deviceId = String(data.deviceId || '');
    let ownerId = Number(data.ownerId);

    if (!deviceId || !Number.isFinite(ownerId)) {
      if (!body.device_id || !body.device_key) {
        throw new WsException('device_auth required before device_data');
      }

      let resolved: { ownerId: number; deviceId: string };
      try {
        resolved = await this.iotDeviceService.authenticateAndResolveOwner(
          body.device_id,
          body.device_key,
        );
      } catch (error) {
        throw this.toWsException(error);
      }
      deviceId = resolved.deviceId;
      ownerId = resolved.ownerId;
      data.deviceId = deviceId;
      data.ownerId = ownerId;
      this.deviceSockets.set(deviceId, client.id);
    }

    const now = Date.now();
    const grpcLogs: NormalizedGrpcLog[] = logs.map((log, index) => {
      const ts = this.toUnixMs(
        (log.timestamp as string | number | undefined) ??
          (log.ts as string | number | undefined) ??
          (log.unix_timestamp as string | number | undefined) ??
          (log.unix_times as string | number | undefined),
      );
      if (Math.abs(now - ts) > this.maxClockSkewMs) {
        throw new WsException('Log timestamp rejected (replay protection)');
      }

      const gaitRaw = log.gaitLabel ?? log.gait_label;

      return {
        id: Number(log.id ?? index + 1),
        temperature: Number(log.temperature ?? log.temp ?? 0),
        ambient_temp: this.toOptionalNumber(
          log.ambientTemp ?? log.ambient_temp,
        ),
        moisture: this.toOptionalNumber(log.moisture),
        gait_label: typeof gaitRaw === 'string' ? gaitRaw : '',
        sos: Boolean(log.sos ?? log.sos_trigger ?? false),
        thighnode_status: String(log.thighnodeStatus ?? log.thighnode_status ?? ''),
        fall_alert: Boolean(log.fallAlert ?? log.fall_alert ?? false),
        // C1: carry heart_rate / spo2 into the synced reading. C2: tag the device.
        heart_rate: this.toOptionalNumber(log.heartRate ?? log.heart_rate),
        spo2: this.toOptionalNumber(log.spo2),
        device_id: deviceId,
        timestamp: ts,
      };
    });

    const realtimeOnly = Boolean(body.realtime_only);
    const result = realtimeOnly
      ? {
          success: true,
          message: 'Realtime-only vital update accepted',
          synced_count: 0,
        }
      : await lastValueFrom(
          this.healthService
            .syncLogs({ user_id: ownerId, logs: grpcLogs })
            .pipe(timeout(SYNC_LOGS_TIMEOUT_MS)),
        );

    // Write vitals directly to the timeline table (bypass sync_history
    // transaction) in one batched insert. ON CONFLICT DO NOTHING against the
    // unique (deviceId, timestamp) index replaces the per-row findOne dedupe.
    try {
      await this.vitalRepository
        .createQueryBuilder()
        .insert()
        .values(
          grpcLogs.map((log) =>
            this.vitalRepository.create({
              deviceId,
              timestamp: new Date(log.timestamp),
              temperature: log.temperature ?? null,
              roomTemperature: log.ambient_temp ?? null,
              moisture: log.moisture != null ? Math.round(log.moisture) : null,
              gaitAnalysis: log.gait_label || null,
              thighnodeStatus: log.thighnode_status || null,
              syncSlot: 'iot_live',
            }),
          ),
        )
        .orIgnore()
        .execute();
    } catch (err) {
      this.logger.warn(`Failed to save realtime vitals to timeline for device ${deviceId}: ${err}`);
    }

    // Write all sensor-driven alerts for the batch via one batched insert.
    try {
      await this.alertWriterService.writeAlertsForLogs(
        deviceId,
        grpcLogs,
        'iot_live',
        this.alertRepository,
      );
    } catch (err) {
      this.logger.warn(`Failed to save realtime alerts for device ${deviceId}: ${err}`);
    }

    // Emit a summary instead of echoing the full log array back out — large
    // batches were doubling the payload on the user-facing socket.
    const timestamps = grpcLogs.map((log) => log.timestamp);
    this.emitToUser(ownerId, 'device.logs.ingested', {
      device_id: deviceId,
      count: grpcLogs.length,
      latest: grpcLogs[grpcLogs.length - 1],
      time_range: {
        from: Math.min(...timestamps),
        to: Math.max(...timestamps),
      },
      ingested_at: new Date().toISOString(),
    });

    return {
      success: true,
      device_id: deviceId,
      synced: result,
    };
  }

  emitToUser(userId: number, event: string, data: unknown) {
    const sockets = this.userSockets.get(userId);
    if (!sockets || sockets.size === 0) {
      return;
    }

    for (const socketId of sockets) {
      this.server.to(socketId).emit(event, data);
    }
  }
}
