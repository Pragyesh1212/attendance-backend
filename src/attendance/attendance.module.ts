
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
import { LocationAlertsController } from './location-alerts.controller';
import { LocationAlertsService } from './location-alerts.service';

@Module({
  imports: [AuthModule, WorkLocationsModule, AuditLogsModule, DevicesModule],
  // Register the specific /attendance/location-alerts route before /attendance/:id.
  controllers: [LocationAlertsController, AttendanceController, EmployeeMonthlyController],
  providers: [AttendanceService, EmployeeMonthlyService, EmployeeMonthlyExportService, LocationAlertsService],
})
export class AttendanceModule {}
