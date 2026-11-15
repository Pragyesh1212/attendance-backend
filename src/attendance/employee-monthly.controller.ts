import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Query, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { CurrentUser } from '../auth/decorators/current-user/current-user';
import { Roles } from '../auth/decorators/roles.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { EmployeeMonthlyService } from './employee-monthly.service';
import type { MonthDayEdit } from './employee-monthly.service';
import { EmployeeMonthlyExportService } from './employee-monthly-export.service';

@Controller('attendance')
@UseGuards(JwtAuthGuard, RolesGuard)
export class EmployeeMonthlyController {
  constructor(private readonly monthly: EmployeeMonthlyService, private readonly exportService: EmployeeMonthlyExportService) {}

  @Get('my/day-overrides')
  @Roles('EMPLOYEE')
  myOverrides(@CurrentUser() user: { sub: string }, @Query('month') month: string) {
    return this.monthly.myDayOverrides(user.sub, month);
  }

  @Get('employees/:employeeId/month')
  @Roles('ADMIN', 'SUPER_ADMIN')
  month(@Param('employeeId', ParseUUIDPipe) id: string, @Query('month') month: string, @CurrentUser() user: { sub: string }) {
    return this.monthly.getMonth(id, month, user.sub);
  }

  // Bulk day-type updates must be registered before the single-date route.
  @Patch('employees/:employeeId/days/bulk')
  @Roles('ADMIN')
  bulkDayType(@Param('employeeId', ParseUUIDPipe) id: string,
              @Body() input: { dates: string[]; dayType: 'WORKDAY' | 'WEEKEND' | 'HOLIDAY' },
              @CurrentUser() user: { sub: string }) {
    return this.monthly.bulkSetDayType(id, input, user.sub);
  }

  @Patch('employees/:employeeId/days/:date')
  @Roles('ADMIN')
  save(@Param('employeeId', ParseUUIDPipe) id: string, @Param('date') date: string,
       @Body() input: MonthDayEdit, @CurrentUser() user: { sub: string }) {
    return this.monthly.editDay(id, date, input, user.sub);
  }

  @Get('employees/:employeeId/month/export')
  @Roles('ADMIN', 'SUPER_ADMIN')
  async download(@Param('employeeId', ParseUUIDPipe) id: string,
                 @Query('month') month: string, @Query('format') format: string,
                 @CurrentUser() user: { sub: string }, @Res() res: Response) {
    const data = await this.monthly.getMonth(id, month, user.sub);
    const result = await this.exportService.export(data, format);
    res.setHeader('Content-Type', result.mime);
    res.setHeader('Content-Disposition', `attachment; filename="${result.filename}"`);
    res.setHeader('Cache-Control', 'private, no-store');
    res.send(result.buffer);
  }
}
