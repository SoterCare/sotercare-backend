import { Module } from '@nestjs/common';
import { ClientsModule, Transport } from '@nestjs/microservices';
import { TypeOrmModule } from '@nestjs/typeorm';
import { join } from 'path';
import * as grpc from '@grpc/grpc-js';
import { SummaryController } from './summary.controller';
import { SummaryService } from './summary.service';
import { SummaryHistory } from './summary-history.entity';

const grpcUrl = process.env.SUMMARY_GRPC_URL || 'localhost:50053';
const isRemote = !grpcUrl.startsWith('localhost') && !grpcUrl.startsWith('127.');
const credentials = isRemote
  ? grpc.credentials.createSsl()
  : grpc.credentials.createInsecure();

@Module({
  imports: [
    TypeOrmModule.forFeature([SummaryHistory]),
    ClientsModule.register([
      {
        name: 'SUMMARY_SERVICE',
        transport: Transport.GRPC,
        options: {
          url: grpcUrl,
          package: 'summary',
          protoPath: join(__dirname, '../../../../libs/common/src/proto/summary.proto'),
          loader: { keepCase: true, defaults: true, json: true, arrays: true },
          credentials,
        },
      },
    ]),
  ],
  controllers: [SummaryController],
  providers: [SummaryService],
  exports: [SummaryService],
})
export class SummaryModule {}
