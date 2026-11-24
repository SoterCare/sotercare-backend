/* eslint-disable @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-return */
/**
 * Phase 0 / GAP-001 revocation: a gateway socket authenticated before an
 * unclaim must not keep delivering telemetry (vital_sign rows, live events)
 * to the former owner for the lifetime of the connection.
 */
import { WsException } from '@nestjs/websockets';
import { of } from 'rxjs';
import { Device, DeviceOwnership } from '../database/entities';
import { IotDevice } from '../iot-device/iot-device.entity';
import { IotDeviceService } from '../iot-device/iot-device.service';
import {
  ALICE,
  BOB,
  configStub,
  createPhase0Db,
} from '../../test/support/phase0-fixtures';
import { RealtimeGateway } from './realtime.gateway';
import { OwnershipService } from '../ownership/ownership.service';

function setup(over: { episodes?: any } = {}) {
  const db = createPhase0Db();
  const iot = new IotDeviceService(
    configStub(),
    db.repository(IotDevice) as any,
    db.repository(Device) as any,
    db.dataSource() as any,
    new OwnershipService(db.repository(DeviceOwnership) as any),
  );
  const syncLogs = jest.fn(() =>
    of({ success: true, message: 'ok', synced_count: 1 }),
  );
  const insertChain: any = {
    insert: () => insertChain,
    values: () => insertChain,
    orIgnore: () => insertChain,
    execute: () => Promise.resolve({}),
  };
  const gateway = new RealtimeGateway(
    { getService: () => ({ syncLogs }) } as any,
    {} as any,
    iot,
    {} as any,
    { create: (row: any) => row, createQueryBuilder: () => insertChain } as any,
    {} as any,
    {
      attach: jest.fn(),
      add: jest.fn(),
      remove: jest.fn(),
      emitToUser: jest.fn(),
    } as any,
    { kick: jest.fn().mockResolvedValue(0) } as any,
    over.episodes ??
      ({ enabled: false, process: jest.fn().mockResolvedValue([]) } as any),
    { ingest: jest.fn() } as any,
  );
  gateway.afterInit();
  const emit = jest
    .spyOn(gateway, 'emitToUser')
    .mockImplementation(() => undefined);
  // A gateway socket that completed device_auth while Alice owned the device.
  const client: any = {
    id: 'sock-1',
    data: { deviceId: 'dev-alice', ownerId: ALICE },
  };
  const batch = {
    logs: [
      {
        temp: 36.5,
        moisture: 2,
        // Observed after any claim made in the test (whole seconds, like the gateway).
        unix_timestamp: Math.floor(Date.now() / 1000) + 2,
      },
    ],
  };
  return { iot, gateway, syncLogs, emit, client, batch };
}

describe('IotDeviceService.resolveCurrentOwner', () => {
  it('reflects claim and unclaim immediately in this process', async () => {
    const { iot } = setup();
    expect(await iot.resolveCurrentOwner('dev-alice')).toBe(ALICE);
    await iot.unclaimDevice(ALICE, 'dev-alice');
    expect(await iot.resolveCurrentOwner('dev-alice')).toBeNull();
    await iot.claimDevice(BOB, 'dev-alice');
    expect(await iot.resolveCurrentOwner('dev-alice')).toBe(BOB);
  });
});

describe('RealtimeGateway device_data after an ownership change', () => {
  it('stops routing telemetry to the former owner once the device is unclaimed', async () => {
    const { iot, gateway, syncLogs, emit, client, batch } = setup();
    await iot.unclaimDevice(ALICE, 'dev-alice');

    await expect(
      gateway.handleDeviceData(client, batch),
    ).rejects.toBeInstanceOf(WsException);
    expect(syncLogs).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();
  });

  it('routes telemetry to the new owner after a re-claim on the same socket', async () => {
    const { iot, gateway, syncLogs, emit, client, batch } = setup();
    await iot.unclaimDevice(ALICE, 'dev-alice');
    await iot.claimDevice(BOB, 'dev-alice');

    await gateway.handleDeviceData(client, batch);
    expect(syncLogs).toHaveBeenCalledWith(
      expect.objectContaining({ user_id: BOB }),
    );
    expect(emit).toHaveBeenCalledWith(
      BOB,
      'device.logs.ingested',
      expect.anything(),
    );
    expect(emit).not.toHaveBeenCalledWith(
      ALICE,
      expect.anything(),
      expect.anything(),
    );
  });

  it('keeps delivering to the unchanged owner', async () => {
    const { gateway, syncLogs, client, batch } = setup();
    await gateway.handleDeviceData(client, batch);
    expect(syncLogs).toHaveBeenCalledWith(
      expect.objectContaining({ user_id: ALICE }),
    );
  });
  it('follows a re-claim even after a batch was refused on the same socket', async () => {
    const { iot, gateway, syncLogs, emit, client, batch } = setup();
    await iot.unclaimDevice(ALICE, 'dev-alice');
    await expect(
      gateway.handleDeviceData(client, batch),
    ).rejects.toBeInstanceOf(WsException);
    await iot.claimDevice(BOB, 'dev-alice');

    await gateway.handleDeviceData(client, batch);
    expect(syncLogs).toHaveBeenCalledWith(
      expect.objectContaining({ user_id: BOB }),
    );
    expect(emit).toHaveBeenCalledWith(
      BOB,
      'device.logs.ingested',
      expect.anything(),
    );
  });
  it('does not attribute readings observed before the new owner period began (PH0-07)', async () => {
    const { iot, gateway, syncLogs, client } = setup();
    await iot.unclaimDevice(ALICE, 'dev-alice');
    await iot.claimDevice(BOB, 'dev-alice');
    const replayed = {
      logs: [
        {
          temp: 36.1,
          moisture: 3,
          unix_timestamp: Math.floor(Date.now() / 1000) - 60,
        },
      ],
    };
    const ack: any = await gateway.handleDeviceData(client, replayed);
    expect(ack).toMatchObject({ success: true, dropped_before_ownership: 1 });
    expect(syncLogs).not.toHaveBeenCalled();
  });
});

describe('RealtimeGateway device_data ack when alert evaluation fails', () => {
  // A strict gateway (STRICT_ACK=1) buffers and resends on a non-success ack;
  // alert ids are deterministic, so the resend cannot duplicate alerts.
  it('does not report success when moisture episode evaluation failed', async () => {
    const { gateway, client, batch } = setup({
      episodes: {
        enabled: true,
        process: jest.fn().mockRejectedValue(new Error('db down')),
      },
    });
    const ack: any = await gateway.handleDeviceData(client, batch);
    expect(ack).toMatchObject({
      success: false,
      retryable: true,
      error: 'alert_write_failed',
    });
  });
});
