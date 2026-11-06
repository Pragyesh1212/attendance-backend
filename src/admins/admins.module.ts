import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { AuditLogsModule } from '../audit-logs/audit-logs.module';
import { AdminsController } from './admins.controller';
import { AdminsService } from './admins.service';

@Module({
  imports: [AuthModule, AuditLogsModule],
  controllers: [AdminsController],
  providers: [AdminsService],
})
export class AdminsModule {}
