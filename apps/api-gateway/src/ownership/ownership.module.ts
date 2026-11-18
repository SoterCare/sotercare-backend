import { Global, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DeviceOwnership } from '../database/entities';
import { OwnershipService } from './ownership.service';

@Global()
@Module({
  imports: [TypeOrmModule.forFeature([DeviceOwnership])],
  providers: [OwnershipService],
  exports: [OwnershipService],
})
export class OwnershipModule {}
