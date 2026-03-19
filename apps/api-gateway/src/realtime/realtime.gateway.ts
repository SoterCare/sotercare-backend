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
import { Inject } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import type { ClientGrpc } from '@nestjs/microservices';
import { lastValueFrom, type Observable } from 'rxjs';
import { Server, Socket } from 'socket.io';
import { IotDeviceService } from '../iot-device/iot-device.service';

interface HealthService {
  syncLogs(data: unknown): Observable<unknown>;
}

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

  private readonly userSockets = new Map<number, Set<string>>();
  private readonly deviceSockets = new Map<string, string>();
  private readonly maxClockSkewMs = Number(
    process.env.IOT_MAX_CLOCK_SKEW_MS || 15 * 60 * 1000,
  );

  constructor(
    @Inject('HEALTH_SERVICE') private readonly healthClient: ClientGrpc,
    private readonly jwtService: JwtService,
    private readonly iotDeviceService: IotDeviceService,
  ) {}

  afterInit() {
    this.healthService =
      this.healthClient.getService<HealthService>('HealthService');
  }

  private toUnixMs(value: number | string | undefined): number {
    if (value === undefined || value === null) {
      return Date.now();
    }

    if (typeof value === 'number' && Number.isFinite(value)) {
      return value;
    }

    const numeric = Number(value);
    if (!Number.isNaN(numeric) && Number.isFinite(numeric)) {
      return numeric;
    }

    const parsed = Date.parse(String(value));
    return Number.isNaN(parsed) ? Date.now() : parsed;
  }

  async handleConnection(client: Socket) {
    const token =
      String(client.handshake.auth?.token || '') ||
      String(client.handshake.headers.authorization || '').replace('Bearer ', '');

    if (!token) {
      return;
    }

    try {
      const payload = await this.jwtService.verifyAsync(token, {
        secret: process.env.JWT_SECRET || 'REMOVED-OLD-PUBLIC-FALLBACK',
      });
      const userId = Number(payload.userId);
      if (!Number.isFinite(userId)) {
        return;
      }

      const existing = this.userSockets.get(userId) || new Set<string>();
      existing.add(client.id);
      this.userSockets.set(userId, existing);
      client.data.userId = userId;
    } catch {
      // keep connection open for unauthenticated client types (device_auth event)
    }
  }

  handleDisconnect(client: Socket) {
    const userId = Number(client.data.userId);
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
    body: { device_id: string; device_key: string; timestamp?: string | number },
  ) {
    const result = await this.iotDeviceService.authenticateAndResolveOwner(
      body.device_id,
      body.device_key,
    );

    this.deviceSockets.set(result.deviceId, client.id);
    client.data.deviceId = result.deviceId;
    client.data.ownerId = result.ownerId;

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
    },
  ) {
    const logs = Array.isArray(body?.logs) ? body.logs : [];
    if (logs.length === 0) {
      throw new WsException('logs are required');
    }

    let deviceId = String(client.data.deviceId || '');
    let ownerId = Number(client.data.ownerId);

    if (!deviceId || !Number.isFinite(ownerId)) {
      if (!body.device_id || !body.device_key) {
        throw new WsException('device_auth required before device_data');
      }

      const resolved = await this.iotDeviceService.authenticateAndResolveOwner(
        body.device_id,
        body.device_key,
      );
      deviceId = resolved.deviceId;
      ownerId = resolved.ownerId;
      client.data.deviceId = deviceId;
      client.data.ownerId = ownerId;
      this.deviceSockets.set(deviceId, client.id);
    }

    const now = Date.now();
    const grpcLogs = logs.map((log, index) => {
      const ts = this.toUnixMs(
        (log.timestamp as string | number | undefined) ??
          (log.ts as string | number | undefined),
      );
      if (Math.abs(now - ts) > this.maxClockSkewMs) {
        throw new WsException('Log timestamp rejected (replay protection)');
      }

      return {
        id: Number(log.id ?? index + 1),
        heart_rate: Number(log.heartRate ?? log.heart_rate ?? 0),
        spo2: Number(log.spo2 ?? 0),
        temperature: Number(log.temperature ?? log.temp ?? 0),
        timestamp: ts,
        acc_x: log.accX ?? log.acc_x,
        acc_y: log.accY ?? log.acc_y,
        acc_z: log.accZ ?? log.acc_z,
        g_total: log.gTotal ?? log.g_total,
        ambient_temp: log.ambientTemp ?? log.ambient_temp,
        moisture: log.moisture,
        sos: Boolean(log.sos ?? false),
        fall_alert: Boolean(log.fallAlert ?? log.fall_alert ?? false),
        gait_label: String(log.gaitLabel ?? log.gait_label ?? ''),
      };
    });

    const result = await lastValueFrom(
      this.healthService.syncLogs({ user_id: ownerId, logs: grpcLogs }),
    );

    this.emitToUser(ownerId, 'device.logs.ingested', {
      device_id: deviceId,
      count: grpcLogs.length,
      logs: grpcLogs,
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
