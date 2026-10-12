import { forwardRef, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Alert, Device } from '../database/entities';
import { AlertsController } from './alerts.controller';
import { InternalAlertsController } from './internal-alerts.controller';
import { AlertsService } from './alerts.service';
import { PipelineStatusService } from './pipeline-status.service';
import { RealtimeModule } from '../realtime/realtime.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([Alert, Device]),
    forwardRef(() => RealtimeModule),
  ],
  controllers: [AlertsController, InternalAlertsController],
  providers: [AlertsService, PipelineStatusService],
  exports: [AlertsService],
})
export class AlertsModule {}
