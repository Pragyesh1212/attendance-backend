
import {
  Controller,
  Get,
  Query,
  Req,
  UseGuards,
  ParseIntPipe,
  DefaultValuePipe,
} from '@nestjs/common';
import { Request } from 'express';

import { DashboardService } from './dashboard.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';

interface AuthenticatedRequest extends Request {
  user: {
    sub: string;
    email: string;
    role: string;
  };
}

@Controller('dashboard')
@UseGuards(JwtAuthGuard, RolesGuard)
export class DashboardController {
  constructor(
    private readonly dashboardService: DashboardService,
  ) {}

  // Admin and Super Admin dashboard overview
  @Get('overview')
  @Roles('ADMIN', 'SUPER_ADMIN')
  getOverview(@Req() request: AuthenticatedRequest) {
    return this.dashboardService.getOverview(request.user);
  }

  // Monthly attendance trend
  @Get('attendance-trend')
  @Roles('ADMIN', 'SUPER_ADMIN')
  getAttendanceTrend(
    @Query('month', new DefaultValuePipe(new Date().getMonth() + 1), ParseIntPipe)
    month: number,

    @Query('year', new DefaultValuePipe(new Date().getFullYear()), ParseIntPipe)
    year: number,

    @Req() request: AuthenticatedRequest,
  ) {
    return this.dashboardService.getAttendanceTrend(month, year, request.user);
  }

  // Department-wise attendance statistics
  @Get('department-stats')
  @Roles('ADMIN', 'SUPER_ADMIN')
  getDepartmentStats(@Req() request: AuthenticatedRequest) {
    return this.dashboardService.getDepartmentStats(request.user);
  }

  // Employee personal dashboard
  @Get('my-stats')
  @Roles('EMPLOYEE')
  getMyStats(@Req() request: AuthenticatedRequest) {
    return this.dashboardService.getMyStats(
      request.user.sub,
    );
  }
}
