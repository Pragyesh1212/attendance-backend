
import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ConflictException,
} from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service';
import { AuditLogsService } from '../audit-logs/audit-logs.service';

import { CreateWorkLocationDto } from './dto/create-work-location.dto';
import { UpdateWorkLocationDto } from './dto/update-work-location.dto';
import { AssignTemporaryLocationDto } from './dto/assign-temporary-location.dto';

@Injectable()
export class WorkLocationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLogsService: AuditLogsService,
  ) {}

  // Create a work location
  async create(dto: CreateWorkLocationDto, actorUserId?: string) {
    const location = await this.prisma.workLocation.create({
      data: {
        name: dto.name,
        type: dto.type,
        address: dto.address,
        latitude: dto.latitude,
        longitude: dto.longitude,
        radiusMeters: dto.radiusMeters ?? 100,
      },
    });

    if (actorUserId) {
      await this.auditLogsService.createLog({
        actorUserId,
        action: 'WORK_LOCATION_CREATED',
        entityType: 'WORK_LOCATION',
        entityId: location.id,
        description: `Work location "${location.name}" was created`,
      });
    }

    return {
      message: 'Work location created successfully',
      location,
    };
  }

  // Get all work locations
  async findAll() {
    const locations = await this.prisma.workLocation.findMany({
      orderBy: {
        createdAt: 'desc',
      },
    });

    return {
      message: 'Work locations fetched successfully',
      total: locations.length,
      locations,
    };
  }

  // Update work location
  async update(
    id: string,
    dto: UpdateWorkLocationDto,
    actorUserId: string,
  ) {
    const existingLocation =
      await this.prisma.workLocation.findUnique({
        where: { id },
      });

    if (!existingLocation) {
      throw new NotFoundException('Work location not found');
    }

    const updatedFields = Object.entries(dto)
  .filter(([, value]) => value !== undefined)
  .map(([key]) => key);

    if (updatedFields.length === 0) {
      throw new BadRequestException(
        'Please provide at least one field to update',
      );
    }

    const location = await this.prisma.workLocation.update({
      where: { id },
      data: {
        ...dto,
      },
    });

    await this.auditLogsService.createLog({
      actorUserId,
      action: 'WORK_LOCATION_UPDATED',
      entityType: 'WORK_LOCATION',
      entityId: location.id,
      description: `Work location "${location.name}" was updated`,
      metadata: {
        updatedFields,
      },
    });

    return {
      message: 'Work location updated successfully',
      location,
    };
  }

  // Manage per-location public IP allowlist. Empty list disables IP-based attendance.
  async updateWifiIps(id: string, allowedPublicIps: string[], actorUserId: string) {
    const existing = await this.prisma.workLocation.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('Work location not found');
    if (existing.status !== 'ACTIVE') throw new BadRequestException('Cannot edit an inactive location');
    const { isIP } = await import('node:net');
    if (!Array.isArray(allowedPublicIps) || allowedPublicIps.length > 20 ||
        allowedPublicIps.some(ip => typeof ip !== 'string' || !isIP(ip.trim()))) {
      throw new BadRequestException('Provide up to 20 valid IPv4 or IPv6 addresses');
    }
    const ips = [...new Set(allowedPublicIps.map(ip => ip.trim()))];
    if (existing.type === 'OFFICE' && ips.length === 0) {
      throw new BadRequestException('Office locations require at least one allowed public IP address');
    }
    const location = await this.prisma.workLocation.update({
      where: { id }, data: { allowedPublicIps: ips },
    });
    await this.auditLogsService.createLog({
      actorUserId, action: 'WORK_LOCATION_UPDATED', entityType: 'WORK_LOCATION',
      entityId: id, description: `Allowed network IPs updated for "${location.name}"`,
      metadata: { updatedFields: ['allowedPublicIps'] },
    });
    return { message: 'Office network IPs updated successfully', location };
  }

  // Soft delete / deactivate work location
  async deactivate(id: string, actorUserId: string) {
    const existingLocation =
      await this.prisma.workLocation.findUnique({
        where: { id },
      });

    if (!existingLocation) {
      throw new NotFoundException('Work location not found');
    }

    if (existingLocation.status === 'INACTIVE') {
      throw new BadRequestException(
        'Work location is already inactive',
      );
    }

    const location = await this.prisma.workLocation.update({
      where: { id },
      data: {
        status: 'INACTIVE',
      },
    });

    await this.auditLogsService.createLog({
      actorUserId,
      action: 'WORK_LOCATION_DEACTIVATED',
      entityType: 'WORK_LOCATION',
      entityId: location.id,
      description: `Work location "${location.name}" was deactivated`,
    });

    return {
      message: 'Work location deactivated successfully',
      location,
    };
  }

  // Reactivate a location, ensuring Office locations have a valid IP allowlist.
  async activate(id: string, suppliedIps: string[] | undefined, actorUserId: string) {
    const existing = await this.prisma.workLocation.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('Work location not found');
    if (existing.status === 'ACTIVE') throw new BadRequestException('Work location is already active');

    const { isIP } = await import('node:net');
    if (suppliedIps !== undefined &&
        (!Array.isArray(suppliedIps) || suppliedIps.length > 20 ||
         suppliedIps.some(ip => typeof ip !== 'string' || !isIP(ip.trim())))) {
      throw new BadRequestException('Provide up to 20 valid IP addresses');
    }
    const ips = suppliedIps === undefined
      ? existing.allowedPublicIps
      : [...new Set(suppliedIps.map(ip => ip.trim()))];
    if (existing.type === 'OFFICE' && ips.length === 0) {
      throw new BadRequestException('Office locations require an allowed public IP before activation');
    }

    const location = await this.prisma.workLocation.update({
      where: { id },
      data: { status: 'ACTIVE', allowedPublicIps: ips },
    });
    await this.auditLogsService.createLog({
      actorUserId, action: 'WORK_LOCATION_UPDATED', entityType: 'WORK_LOCATION',
      entityId: location.id, description: `Work location "${location.name}" was reactivated`,
      metadata: { updatedFields: ['status', 'allowedPublicIps'] },
    });
    return { message: 'Work location activated successfully', location };
  }

  // Assign permanent work location to an employee
  async assignPermanentLocation(
    employeeProfileId: string,
    workLocationId: string,
    actorUserId?: string,
  ) {
    const employee = await this.prisma.employeeProfile.findUnique({
      where: {
        id: employeeProfileId,
      },
    });

    if (!employee) {
      throw new NotFoundException('Employee not found');
    }

    const location = await this.prisma.workLocation.findUnique({
      where: {
        id: workLocationId,
      },
    });

    if (!location) {
      throw new NotFoundException('Work location not found');
    }

    if (location.status !== 'ACTIVE') {
      throw new BadRequestException(
        'Cannot assign an inactive work location',
      );
    }

    const updatedEmployee = await this.prisma.employeeProfile.update({
      where: {
        id: employeeProfileId,
      },
      data: {
        workLocationId: workLocationId,
      },
      include: {
        workLocation: true,
        user: {
          select: {
            email: true,
            status: true,
          },
        },
      },
    });

    if (actorUserId) {
      await this.auditLogsService.createLog({
        actorUserId,
        action: 'PERMANENT_LOCATION_ASSIGNED',
        entityType: 'EMPLOYEE',
        entityId: employeeProfileId,
        description: `Permanent work location "${location.name}" assigned to employee`,
        metadata: {
          workLocationId,
          workLocationName: location.name,
        },
      });
    }

    return {
      message: 'Permanent work location assigned successfully',
      employee: updatedEmployee,
    };
  }

  // Assign temporary work location to an employee
  async assignTemporaryLocation(
    employeeProfileId: string,
    dto: AssignTemporaryLocationDto,
    createdByUserId: string,
  ) {
    const startAt = new Date(dto.startAt);
    const endAt = new Date(dto.endAt);

    // Validate assignment time window
    if (
      Number.isNaN(startAt.getTime()) ||
      Number.isNaN(endAt.getTime()) ||
      endAt <= startAt
    ) {
      throw new BadRequestException(
        'End time must be later than start time',
      );
    }

    // Check employee
    const employee = await this.prisma.employeeProfile.findUnique({
      where: { id: employeeProfileId },
    });

    if (!employee) {
      throw new NotFoundException('Employee not found');
    }

    // Check work location
    const location = await this.prisma.workLocation.findUnique({
      where: { id: dto.workLocationId },
    });

    if (!location) {
      throw new NotFoundException('Work location not found');
    }

    if (location.status !== 'ACTIVE') {
      throw new BadRequestException(
        'Cannot assign an inactive work location',
      );
    }

    // Prevent overlapping temporary assignments
    const overlappingAssignment =
      await this.prisma.locationAssignment.findFirst({
        where: {
          employeeProfileId,
          startAt: { lt: endAt },
          endAt: { gt: startAt },
        },
      });

    if (overlappingAssignment) {
      throw new ConflictException(
        'Employee already has a temporary location assignment during this time period',
      );
    }

    // Create temporary assignment
    const assignment = await this.prisma.locationAssignment.create({
      data: {
        employeeProfileId,
        workLocationId: dto.workLocationId,
        createdByUserId,
        startAt,
        endAt,
        reason: dto.reason,
      },
      include: {
        workLocation: true,
        employeeProfile: {
          select: {
            employeeCode: true,
            firstName: true,
            lastName: true,
          },
        },
      },
    });

    await this.auditLogsService.createLog({
      actorUserId: createdByUserId,
      action: 'TEMPORARY_LOCATION_ASSIGNED',
      entityType: 'LOCATION_ASSIGNMENT',
      entityId: assignment.id,
      description: `Temporary work location "${location.name}" assigned to employee`,
      metadata: {
        employeeProfileId,
        workLocationId: dto.workLocationId,
        startAt: startAt.toISOString(),
        endAt: endAt.toISOString(),
      },
    });

    return {
      message: 'Temporary work location assigned successfully',
      assignment,
    };
  }

  // Get effective work location for employee
  async getEffectiveLocation(employeeProfileId: string) {
    const now = new Date();

    const employee = await this.prisma.employeeProfile.findUnique({
      where: { id: employeeProfileId },
      include: {
        workLocation: true,
      },
    });

    if (!employee) {
      throw new NotFoundException('Employee not found');
    }

    // Check active temporary assignment
    const temporaryAssignment =
      await this.prisma.locationAssignment.findFirst({
        where: {
          employeeProfileId,
          startAt: { lte: now },
          endAt: { gt: now },
          workLocation: {
            status: 'ACTIVE',
          },
        },
        include: {
          workLocation: true,
        },
      });

    if (temporaryAssignment) {
      return {
        location: temporaryAssignment.workLocation,
        assignmentType: 'TEMPORARY',
        assignmentId: temporaryAssignment.id,
      };
    }

    // Otherwise use permanent location
    if (
      employee.workLocation &&
      employee.workLocation.status === 'ACTIVE'
    ) {
      return {
        location: employee.workLocation,
        assignmentType: 'PERMANENT',
        assignmentId: null,
      };
    }

    throw new NotFoundException(
      'No active work location assigned to this employee',
    );
  }
}
