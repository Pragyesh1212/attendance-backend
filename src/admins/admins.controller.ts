import {
  Body,
  Controller,
  Post,
  Get,
  Query,
  Param,
  ParseUUIDPipe,
  Patch,
  UseGuards,
  Req,
} from '@nestjs/common';
import type { Request } from 'express';

import { AdminsService } from './admins.service';
import { CreateAdminDto } from './dto/create-admin.dto';
import { GetAdminsDto } from './dto/get-admins.dto';
import { UpdateAdminDto } from './dto/update-admin.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';

interface AuthenticatedRequest extends Request {
  user: { sub: string; email: string; role: string };
}

@Controller('users')
@UseGuards(JwtAuthGuard, RolesGuard)
export class AdminsController {
  constructor(private readonly adminsService: AdminsService) {}

  @Post('admins')
  @Roles('SUPER_ADMIN')
  createAdmin(@Body() dto: CreateAdminDto, @Req() request: AuthenticatedRequest) {
    return this.adminsService.createAdmin(dto, request.user.sub);
  }

  @Get('admins')
  @Roles('SUPER_ADMIN')
  getAdmins(@Query() query: GetAdminsDto) {
    return this.adminsService.getAdmins(query);
  }

  @Get('admins/:id')
  @Roles('SUPER_ADMIN')
  getAdminById(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.adminsService.getAdminById(id);
  }

  @Patch('admins/:id')
  @Roles('SUPER_ADMIN')
  updateAdmin(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: UpdateAdminDto,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.adminsService.updateAdmin(id, dto, request.user.sub);
  }

  @Patch('admins/:id/deactivate')
  @Roles('SUPER_ADMIN')
  deactivateAdmin(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.adminsService.deactivateAdmin(id, request.user.sub);
  }

  @Patch('admins/:id/reactivate')
  @Roles('SUPER_ADMIN')
  reactivateAdmin(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.adminsService.reactivateAdmin(id, request.user.sub);
  }
}
