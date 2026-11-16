import { Body, Controller, Get, Post, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { CurrentUser } from '../auth/decorators/current-user/current-user';
import { LocationAlertEventDto } from './dto/location-alert-event.dto';
import { LocationAlertsService } from './location-alerts.service';

@Controller('attendance/location-alerts')
@UseGuards(JwtAuthGuard, RolesGuard)
export class LocationAlertsController {
  constructor(private readonly alerts: LocationAlertsService) {}

  @Post('my/exit')
  @Roles('EMPLOYEE')
  reportExit(@CurrentUser() user: { sub: string }, @Body() dto: LocationAlertEventDto) {
    return this.alerts.reportExit(user.sub, dto);
  }

  @Post('my/return')
  @Roles('EMPLOYEE')
  reportReturn(@CurrentUser() user: { sub: string }, @Body() dto: LocationAlertEventDto) {
    return this.alerts.reportReturn(user.sub, dto);
  }

  @Get()
  @Roles('ADMIN')
  getAlerts(
    @CurrentUser() user: { sub: string },
    @Query('date') date?: string,
    @Query('employeeName') employeeName?: string,
    @Query('status') status?: string,
    @Query('workLocationId') workLocationId?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    return this.alerts.getAlerts(user.sub, { date, employeeName, status, workLocationId, page, limit });
  }
}
