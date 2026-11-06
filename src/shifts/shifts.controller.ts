
import {
  Controller,
  Get,
  Post,
  Patch,
  Body,
  Param,
  UseGuards,
  ParseUUIDPipe,
  Req,
} from '@nestjs/common';

import type { Request } from 'express';

import { ShiftsService } from './shifts.service';
import { CreateShiftDto } from './dto/create-shift.dto';
import { UpdateShiftDto } from './dto/update-shift.dto';

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

@Controller('shifts')
@UseGuards(JwtAuthGuard, RolesGuard)
export class ShiftsController {
  constructor(private readonly shiftsService: ShiftsService) {}

  @Post()
  @Roles('ADMIN')
  createShift(
    @Body() dto: CreateShiftDto,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.shiftsService.createShift(dto, request.user.sub);
  }

  @Get()
  @Roles('ADMIN')
  getShifts(@Req() request: AuthenticatedRequest) {
    return this.shiftsService.getShifts(
      request.user.sub,
      request.user.role,
    );
  }

  @Get(':id')
  @Roles('ADMIN')
  getShiftById(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.shiftsService.getShiftById(
      id,
      request.user.sub,
      request.user.role,
    );
  }

  @Patch(':id')
  @Roles('ADMIN')
  updateShift(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateShiftDto,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.shiftsService.updateShift(
      id,
      dto,
      request.user.sub,
    );
  }

}