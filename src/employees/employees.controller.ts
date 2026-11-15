
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
  UploadedFile, UseInterceptors, Res,
} from '@nestjs/common';

import type { Request, Response } from 'express';
import { FileInterceptor } from '@nestjs/platform-express';

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

  // Photo upload is separate from employee creation so older JSON clients still work.
  @Post('employees/:id/avatar')
  @Roles('ADMIN')
  @UseInterceptors(FileInterceptor('avatar', { limits: { fileSize: 1024 * 1024 } }))
  uploadAvatar(
    @Param('id', ParseUUIDPipe) id: string,
    @UploadedFile() file: { buffer: Buffer; size: number; mimetype: string },
    @Req() request: AuthenticatedRequest,
  ) {
    return this.employeesService.uploadEmployeeAvatar(id, request.user, file);
  }

  // An employee can securely view only their own private S3 photograph.
  @Get('me/avatar')
  @Roles('EMPLOYEE')
  async getOwnAvatar(
    @Req() request: AuthenticatedRequest,
    @Res() response: Response,
  ) {
    const avatar = await this.employeesService.getOwnAvatar(request.user);
    response.setHeader('Content-Type', avatar.mimeType);
    response.setHeader('Cache-Control', 'private, no-store');
    response.send(avatar.content);
  }

  @Get('employees/:id/avatar')
  @Roles('ADMIN', 'SUPER_ADMIN')
  async getAvatar(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() request: AuthenticatedRequest,
    @Res() response: Response,
  ) {
    const avatar = await this.employeesService.getEmployeeAvatar(id, request.user);
    response.setHeader('Content-Type', avatar.mimeType);
    response.setHeader('Cache-Control', 'private, no-store');
    response.send(avatar.content);
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
