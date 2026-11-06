
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

import { DepartmentsService } from './departments.service';
import { CreateDepartmentDto } from './dto/create-department.dto';
import { UpdateDepartmentDto } from './dto/update-department.dto';

import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';

interface AuthenticatedRequest extends Request {
  user: {
    sub: string;
    email: string;
    role: string;
    organizationId: string | null;
  };
}

@Controller('departments')
@UseGuards(JwtAuthGuard, RolesGuard)
export class DepartmentsController {
  constructor(
    private readonly departmentsService: DepartmentsService,
  ) {}

  @Post()
  @Roles('ADMIN')
  createDepartment(
    @Body() dto: CreateDepartmentDto,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.departmentsService.createDepartment(
      dto,
      request.user.sub,
    );
  }

  @Get()
  @Roles('SUPER_ADMIN', 'ADMIN')
  getDepartments(@Req() request: AuthenticatedRequest) {
    return this.departmentsService.getDepartments(
      request.user.sub,
      request.user.role,
    );
  }

  @Get(':id')
  @Roles('SUPER_ADMIN', 'ADMIN')
  getDepartmentById(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.departmentsService.getDepartmentById(
      id,
      request.user.sub,
      request.user.role,
    );
  }

  @Patch(':id')
  @Roles('ADMIN')
  updateDepartment(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateDepartmentDto,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.departmentsService.updateDepartment(
      id,
      dto,
      request.user.sub,
    );
  }
}
