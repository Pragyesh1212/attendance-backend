import { Module } from '@nestjs/common';
import { WorkLocationsController } from './work-locations.controller';
import { WorkLocationsService } from './work-locations.service';
import { PrismaModule } from '../prisma/prisma.module';
import { AuthModule } from '../auth/auth.module';
import { AuditLogsModule } from '../audit-logs/audit-logs.module';

@Module({
  imports: [PrismaModule, AuthModule, AuditLogsModule],
  controllers: [WorkLocationsController],
  providers: [WorkLocationsService],
  exports: [WorkLocationsService],
})
export class WorkLocationsModule {}