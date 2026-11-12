import {
  Controller,
  Post,
  Body,
  UseGuards,
  Get,
  Param,
  Query,
  Req,
} from '@nestjs/common';

import type { Request } from 'express';

import { AttendanceService } from './attendance.service';
import { PunchInDto } from './dto/punch-in.dto';
import { PunchOutDto } from './dto/punch-out.dto';
import { GetAttendanceDto } from './dto/get-attendance.dto';
import { ReviewAttendanceDto } from './dto/review-attendance.dto';

import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { CurrentUser } from '../auth/decorators/current-user/current-user';

type CreateAttendanceCorrectionDto = Parameters<
  AttendanceService['createAttendanceCorrection']
>[1];

type ReviewAttendanceCorrectionDto = Parameters<
  AttendanceService['reviewAttendanceCorrection']
>[2];

@Controller('attendance')
@UseGuards(JwtAuthGuard, RolesGuard)
export class AttendanceController {
  constructor(
    private readonly attendanceService: AttendanceService,
  ) {}

// EMPLOYEE: PUNCH IN
@Post('punch-in')
@Roles('EMPLOYEE')
async punchIn(
  @CurrentUser() user: { sub: string },
  @Body() dto: PunchInDto,
  @Req() request: Request,
) {
  return this.attendanceService.punchIn(
    user.sub,
    dto,
    request.ip ?? request.socket.remoteAddress ?? ''
  );
}

 // EMPLOYEE: PUNCH OUT
@Post('punch-out')
@Roles('EMPLOYEE')
async punchOut(
  @CurrentUser() user: { sub: string },
  @Body() dto: PunchOutDto,
  @Req() request: Request,
) {
  return this.attendanceService.punchOut(
    user.sub,
    dto,
    request.ip ?? request.socket.remoteAddress ?? ''
  );
}
  // EMPLOYEE: Read shift cutoff for the Punch In button (server verified).
  @Get('my/punch-in-policy')
  @Roles('EMPLOYEE')
  async getMyPunchInPolicy(@CurrentUser() user: { sub: string }) {
    return this.attendanceService.getMyPunchInPolicy(user.sub);
  }

  // EMPLOYEE: OWN ATTENDANCE
  @Get('my')
  @Roles('EMPLOYEE')
  async getMyAttendance(
    @CurrentUser() user: { sub: string },
    @Query() query: GetAttendanceDto,
  ) {
    return this.attendanceService.getMyAttendance(
      user.sub,
      query,
    );
  }

  // EMPLOYEE: REQUEST ATTENDANCE CORRECTION
  @Post('corrections')
  @Roles('EMPLOYEE')
  async createAttendanceCorrection(
    @CurrentUser() user: { sub: string },
    @Body() dto: CreateAttendanceCorrectionDto,
  ) {
    return this.attendanceService.createAttendanceCorrection(
      user.sub,
      dto,
    );
  }

  // EMPLOYEE: VIEW OWN CORRECTION REQUESTS
  @Get('corrections/my')
  @Roles('EMPLOYEE')
  async getMyAttendanceCorrections(
    @CurrentUser() user: { sub: string },
  ) {
    return this.attendanceService.getMyAttendanceCorrections(
      user.sub,
    );
  }

  // ADMIN / SUPER ADMIN: MISSING PUNCH-OUTS
  @Get('missing-punch-outs')
  @Roles('ADMIN', 'SUPER_ADMIN')
  async getMissingPunchOuts(@CurrentUser() user: { sub: string }) {
    return this.attendanceService.getMissingPunchOuts(user.sub);
  }

  // ADMIN / SUPER ADMIN: PENDING CORRECTION REQUESTS
  @Get('corrections/pending')
  @Roles('ADMIN', 'SUPER_ADMIN')
  async getPendingAttendanceCorrections(@CurrentUser() user: { sub: string }) {
    return this.attendanceService.getPendingAttendanceCorrections(user.sub);
  }

  // ADMIN / SUPER ADMIN: REVIEW CORRECTION REQUEST
  @Post('corrections/:requestId/review')
  @Roles('ADMIN', 'SUPER_ADMIN')
  async reviewAttendanceCorrection(
    @Param('requestId') requestId: string,
    @CurrentUser() user: { sub: string },
    @Body() dto: ReviewAttendanceCorrectionDto,
  ) {
    return this.attendanceService.reviewAttendanceCorrection(
      requestId,
      user.sub,
      dto,
    );
  }

  // ADMIN / SUPER ADMIN: PENDING LATE ARRIVAL APPROVALS
  @Get('approvals/pending')
  @Roles('ADMIN', 'SUPER_ADMIN')
  async getPendingApprovals(@CurrentUser() user: { sub: string }) {
    return this.attendanceService.getPendingApprovals(user.sub);
  }

  // ADMIN / SUPER ADMIN: REVIEW LATE ARRIVAL
  @Post('approvals/:sessionId/review')
  @Roles('ADMIN', 'SUPER_ADMIN')
  async reviewAttendance(
    @Param('sessionId') sessionId: string,
    @CurrentUser() user: { sub: string },
    @Body() dto: ReviewAttendanceDto,
  ) {
    return this.attendanceService.reviewAttendance(
      sessionId,
      user.sub,
      dto,
    );
  }

  // ADMIN / SUPER ADMIN: GET ALL ATTENDANCE
  @Get()
  @Roles('ADMIN', 'SUPER_ADMIN')
  async getAllAttendance(
    @Query() query: GetAttendanceDto,
    @CurrentUser() user: { sub: string },
  ) {
    return this.attendanceService.getAllAttendance(query, user.sub);
  }

  // ADMIN / SUPER ADMIN: GET ATTENDANCE DETAILS
  @Get(':id')
  @Roles('ADMIN', 'SUPER_ADMIN')
  async getAttendanceById(
    @Param('id') id: string,
    @CurrentUser() user: { sub: string },
  ) {
    return this.attendanceService.getAttendanceById(id, user.sub);
  }
}