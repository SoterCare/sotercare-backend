import { Module } from '@nestjs/common';
import { ClientsModule, Transport } from '@nestjs/microservices';
import { join } from 'path';
import * as grpc from '@grpc/grpc-js';
import { NurseController } from './nurse.controller';
import { NurseService } from './nurse.service';

const grpcUrl = process.env.SUMMARY_GRPC_URL || 'localhost:50053';
const isRemote = !grpcUrl.startsWith('localhost') && !grpcUrl.startsWith('127.');
const credentials = isRemote
  ? grpc.credentials.createSsl()
  : grpc.credentials.createInsecure();

@Module({
  imports: [
    ClientsModule.register([
      {
        name: 'SUMMARY_SERVICE',
        transport: Transport.GRPC,
        options: {
          url: grpcUrl,
          package: 'summary',
          protoPath: join(
            __dirname,
            '../../../../libs/common/src/proto/summary.proto',
          ),
          loader: { keepCase: true, defaults: true, json: true, arrays: true },
          credentials,
        },
      },
    ]),
  ],
  controllers: [NurseController],
  providers: [NurseService],
})
export class NurseModule {}
