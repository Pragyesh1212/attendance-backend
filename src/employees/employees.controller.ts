
import {
  Body,
  Controller,
  Post,
  Get,
  Query,
  Param,
  Patch,
  UseGuards,
  ParseUUIDPipe,
  Req,
} from '@nestjs/common';

import type { Request } from 'express';

import { EmployeesService } from './employees.service';
import { CreateEmployeeDto } from './dto/create-employee.dto';
import { GetEmployeesDto } from './dto/get-employees.dto';
import { UpdateEmployeeDto } from './dto/update-employee.dto';
import { AssignEmployeeShiftDto } from './dto/assign-employee-shift.dto';

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

@Controller('users')
@UseGuards(JwtAuthGuard, RolesGuard)
export class EmployeesController {
  constructor(private readonly employeesService: EmployeesService) {}

  // Create employee - ADMIN only
  @Post('employees')
  @Roles('ADMIN')
  createEmployee(
    @Body() dto: CreateEmployeeDto,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.employeesService.createEmployee(
      dto,
      request.user,
    );
  }

  // Get employees - SUPER_ADMIN sees all; ADMIN sees own organization
  @Get('employees')
  @Roles('SUPER_ADMIN', 'ADMIN')
  getEmployees(
    @Query() query: GetEmployeesDto,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.employeesService.getEmployees(
      query,
      request.user,
    );
  }

  // Get employee by ID
  @Get('employees/:id')
  @Roles('SUPER_ADMIN', 'ADMIN')
  getEmployeeById(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.employeesService.getEmployeeById(
      id,
      request.user,
    );
  }

  // Update employee - ADMIN only
  @Patch('employees/:id')
  @Roles('ADMIN')
  updateEmployee(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateEmployeeDto,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.employeesService.updateEmployee(
      id,
      dto,
      request.user,
    );
  }

  // Deactivate employee - ADMIN only
  @Patch('employees/:id/deactivate')
  @Roles('ADMIN')
  deactivateEmployee(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.employeesService.deactivateEmployee(
      id,
      request.user,
    );
  }

  // Reactivate employee - ADMIN only
  @Patch('employees/:id/reactivate')
  @Roles('ADMIN')
  reactivateEmployee(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.employeesService.reactivateEmployee(
      id,
      request.user,
    );
  }

  // Assign employee shift - ADMIN only
  @Patch('employees/:id/shift')
  @Roles('ADMIN')
  assignEmployeeShift(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AssignEmployeeShiftDto,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.employeesService.assignEmployeeShift(
      id,
      dto,
      request.user,
    );
  }
}
