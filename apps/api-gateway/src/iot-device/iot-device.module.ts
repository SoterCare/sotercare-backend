import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { IotDevice } from './iot-device.entity';
import { IotDeviceController } from './iot-device.controller';
import { IotDeviceService } from './iot-device.service';

@Module({
  imports: [TypeOrmModule.forFeature([IotDevice])],
  controllers: [IotDeviceController],
  providers: [IotDeviceService],
  exports: [IotDeviceService],
})
export class IotDeviceModule {}
