
import { Module } from '@nestjs/common';
import { AttendanceController } from './attendance.controller';
import { AttendanceService } from './attendance.service';
import { EmployeeMonthlyService } from './employee-monthly.service';
import { EmployeeMonthlyExportService } from './employee-monthly-export.service';
import { EmployeeMonthlyController } from './employee-monthly.controller';
import { AuthModule } from '../auth/auth.module';
import { WorkLocationsModule } from '../work-locations/work-locations.module';
import { AuditLogsModule } from '../audit-logs/audit-logs.module';
import { DevicesModule } from '../devices/devices.module';

@Module({
  imports: [AuthModule, WorkLocationsModule, AuditLogsModule, DevicesModule],
  controllers: [AttendanceController, EmployeeMonthlyController],
  providers: [AttendanceService, EmployeeMonthlyService, EmployeeMonthlyExportService],
})
export class AttendanceModule {}
