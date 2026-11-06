
import {
  Body,
  Controller,
  Post,
  Get,
  UseGuards,
  Patch,
  Param,
  Delete,
} from '@nestjs/common';

import { WorkLocationsService } from './work-locations.service';
import { CreateWorkLocationDto } from './dto/create-work-location.dto';
import { UpdateWorkLocationDto } from './dto/update-work-location.dto';
import { AssignPermanentLocationDto } from './dto/assign-permanent-location.dto';
import { AssignTemporaryLocationDto } from './dto/assign-temporary-location.dto';

import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { CurrentUser } from '../auth/decorators/current-user/current-user';

@Controller('work-locations')
@UseGuards(JwtAuthGuard, RolesGuard)
export class WorkLocationsController {
  constructor(
    private readonly workLocationsService: WorkLocationsService,
  ) {}

  // Create work location
  @Post()
  @Roles('SUPER_ADMIN', 'ADMIN')
  async create(
    @Body() dto: CreateWorkLocationDto,
    @CurrentUser() user: { sub: string },
  ) {
    return this.workLocationsService.create(dto, user.sub);
  }

  // Get all work locations
  @Get()
  @Roles('SUPER_ADMIN', 'ADMIN')
  async findAll() {
    return this.workLocationsService.findAll();
  }

  // Update work location
  @Patch(':id')
  @Roles('SUPER_ADMIN', 'ADMIN')
  async update(
    @Param('id') id: string,
    @Body() dto: UpdateWorkLocationDto,
    @CurrentUser() user: { sub: string },
  ) {
    return this.workLocationsService.update(id, dto, user.sub);
  }

  // Soft delete (deactivate) work location
  @Delete(':id')
  @Roles('SUPER_ADMIN', 'ADMIN')
  async deactivate(
    @Param('id') id: string,
    @CurrentUser() user: { sub: string },
  ) {
    return this.workLocationsService.deactivate(id, user.sub);
  }

  // Assign permanent work location
  @Patch('employees/:employeeProfileId/permanent')
  @Roles('SUPER_ADMIN', 'ADMIN')
  async assignPermanentLocation(
    @Param('employeeProfileId') employeeProfileId: string,
    @Body() dto: AssignPermanentLocationDto,
    @CurrentUser() user: { sub: string },
  ) {
    return this.workLocationsService.assignPermanentLocation(
      employeeProfileId,
      dto.workLocationId,
      user.sub,
    );
  }

  // Assign temporary work location
  @Post('employees/:employeeProfileId/temporary')
  @Roles('SUPER_ADMIN', 'ADMIN')
  async assignTemporaryLocation(
    @Param('employeeProfileId') employeeProfileId: string,
    @Body() dto: AssignTemporaryLocationDto,
    @CurrentUser() user: { sub: string },
  ) {
    return this.workLocationsService.assignTemporaryLocation(
      employeeProfileId,
      dto,
      user.sub,
    );
  }
}
