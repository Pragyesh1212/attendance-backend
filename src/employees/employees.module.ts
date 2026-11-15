
import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { AuditLogsModule } from '../audit-logs/audit-logs.module';

import { EmployeesController } from './employees.controller';
import { EmployeesService } from './employees.service';
import { EmployeeS3AvatarStorageService } from './employee-s3-avatar-storage.service';

@Module({
  imports: [AuthModule, AuditLogsModule],
  controllers: [EmployeesController],
  providers: [EmployeesService, EmployeeS3AvatarStorageService],
})
export class EmployeesModule {}
