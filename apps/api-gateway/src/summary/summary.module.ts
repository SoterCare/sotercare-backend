import { Module } from '@nestjs/common';
import { ClientsModule, Transport } from '@nestjs/microservices';
import { TypeOrmModule } from '@nestjs/typeorm';
import { join } from 'path';
import { SummaryController } from './summary.controller';
import { SummaryService } from './summary.service';
import { SummaryHistory } from './summary-history.entity';

@Module({
  imports: [
    TypeOrmModule.forFeature([SummaryHistory]),
    ClientsModule.register([
      {
        name: 'SUMMARY_SERVICE',
        transport: Transport.GRPC,
        options: {
          url: process.env.SUMMARY_GRPC_URL || 'localhost:50053',
          package: 'summary',
          protoPath: join(__dirname, '../../../../libs/common/src/proto/summary.proto'),
          loader: { keepCase: true, defaults: true, json: true, arrays: true },
        },
      },
    ]),
  ],
  controllers: [SummaryController],
  providers: [SummaryService],
  exports: [SummaryService],
})
export class SummaryModule {}
