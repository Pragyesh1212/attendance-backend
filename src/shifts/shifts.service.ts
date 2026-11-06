
import {
  Injectable,
  ConflictException,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
} from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service';
import { AuditLogsService } from '../audit-logs/audit-logs.service';

import { CreateShiftDto } from './dto/create-shift.dto';
import { UpdateShiftDto } from './dto/update-shift.dto';

@Injectable()
export class ShiftsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLogsService: AuditLogsService,
  ) {}

  private async getAdminOrganization(actorUserId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: actorUserId },
      select: {
        role: true,
        organizationId: true,
      },
    });

    if (!user || user.role !== 'ADMIN') {
      throw new ForbiddenException('Admin access required');
    }

    if (!user.organizationId) {
      throw new BadRequestException(
        'Your admin account is not assigned to an organization',
      );
    }

    return user.organizationId;
  }

  private validateShiftPolicy(
    startTime: string,
    endTime: string,
    lateReasonAfterMinutes: number | null,
    approvalRequiredAfterMinutes: number | null,
  ) {
    if (startTime === endTime) {
      throw new BadRequestException(
        'Shift start time and end time cannot be the same',
      );
    }

    if (
      lateReasonAfterMinutes !== null &&
      approvalRequiredAfterMinutes !== null &&
      approvalRequiredAfterMinutes <= lateReasonAfterMinutes
    ) {
      throw new BadRequestException(
        'Approval threshold must be greater than the late reason threshold',
      );
    }
  }

  async createShift(
    dto: CreateShiftDto,
    actorUserId: string,
  ) {
    const organizationId =
      await this.getAdminOrganization(actorUserId);

    const name = dto.name.trim();

    if (!name) {
      throw new BadRequestException(
        'Shift name cannot be empty',
      );
    }

    const existing = await this.prisma.shift.findFirst({
      where: {
        organizationId,
        name,
      },
    });

    if (existing) {
      throw new ConflictException(
        'Shift name already exists in your organization',
      );
    }

    const lateReason = dto.lateReasonAfterMinutes ?? null;
    const approvalRequired =
      dto.approvalRequiredAfterMinutes ?? null;

    this.validateShiftPolicy(
      dto.startTime,
      dto.endTime,
      lateReason,
      approvalRequired,
    );

    const shift = await this.prisma.shift.create({
      data: {
        name,
        organizationId,
        startTime: dto.startTime,
        endTime: dto.endTime,
        gracePeriodMinutes: dto.gracePeriodMinutes ?? 10,
        lateReasonAfterMinutes: lateReason,
        approvalRequiredAfterMinutes: approvalRequired,
      },
      include: {
        _count: {
          select: { employees: true },
        },
      },
    });

    await this.auditLogsService.createLog({
      actorUserId,
      action: 'SHIFT_CREATED',
      entityType: 'SHIFT',
      entityId: shift.id,
      description: `Shift created: ${shift.name}`,
    });

    return {
      message: 'Shift created successfully',
      data: shift,
    };
  }

  async getShifts(
    actorUserId: string,
    role: string,
  ) {
    const organizationId =
      role === 'ADMIN'
        ? await this.getAdminOrganization(actorUserId)
        : undefined;

    const shifts = await this.prisma.shift.findMany({
      where:
        role === 'ADMIN'
          ? { organizationId }
          : {},
      orderBy: { name: 'asc' },
      include: {
        _count: {
          select: { employees: true },
        },
      },
    });

    return {
      message: 'Shifts retrieved successfully',
      data: shifts,
      total: shifts.length,
    };
  }

  async getShiftById(
    id: string,
    actorUserId: string,
    role: string,
  ) {
    const organizationId =
      role === 'ADMIN'
        ? await this.getAdminOrganization(actorUserId)
        : undefined;

    const shift = await this.prisma.shift.findFirst({
      where: {
        id,
        ...(role === 'ADMIN' ? { organizationId } : {}),
      },
      include: {
        _count: {
          select: { employees: true },
        },
      },
    });

    if (!shift) {
      throw new NotFoundException('Shift not found');
    }

    return {
      message: 'Shift retrieved successfully',
      data: shift,
    };
  }

  async updateShift(
    id: string,
    dto: UpdateShiftDto,
    actorUserId: string,
  ) {
    const organizationId =
      await this.getAdminOrganization(actorUserId);

    const existingShift = await this.prisma.shift.findFirst({
      where: {
        id,
        organizationId,
      },
    });

    if (!existingShift) {
      throw new NotFoundException(
        'Shift not found in your organization',
      );
    }

    const name = dto.name?.trim();

    if (dto.name !== undefined && !name) {
      throw new BadRequestException(
        'Shift name cannot be empty',
      );
    }

    if (name && name !== existingShift.name) {
      const duplicate = await this.prisma.shift.findFirst({
        where: {
          organizationId,
          name,
          id: { not: id },
        },
      });

      if (duplicate) {
        throw new ConflictException(
          'Shift name already exists in your organization',
        );
      }
    }

    const startTime = dto.startTime ?? existingShift.startTime;
    const endTime = dto.endTime ?? existingShift.endTime;

    const lateReason =
      dto.lateReasonAfterMinutes !== undefined
        ? dto.lateReasonAfterMinutes
        : existingShift.lateReasonAfterMinutes;

    const approvalRequired =
      dto.approvalRequiredAfterMinutes !== undefined
        ? dto.approvalRequiredAfterMinutes
        : existingShift.approvalRequiredAfterMinutes;

    this.validateShiftPolicy(
      startTime,
      endTime,
      lateReason,
      approvalRequired,
    );

    const updatedShift = await this.prisma.shift.update({
      where: { id },
      data: {
        ...(name !== undefined && { name }),
        ...(dto.startTime !== undefined && {
          startTime: dto.startTime,
        }),
        ...(dto.endTime !== undefined && {
          endTime: dto.endTime,
        }),
        ...(dto.gracePeriodMinutes !== undefined && {
          gracePeriodMinutes: dto.gracePeriodMinutes,
        }),
        ...(dto.lateReasonAfterMinutes !== undefined && {
          lateReasonAfterMinutes: dto.lateReasonAfterMinutes,
        }),
        ...(dto.approvalRequiredAfterMinutes !== undefined && {
          approvalRequiredAfterMinutes:
            dto.approvalRequiredAfterMinutes,
        }),
        ...(dto.status !== undefined && {
          status: dto.status,
        }),
      },
      include: {
        _count: {
          select: { employees: true },
        },
      },
    });

    await this.auditLogsService.createLog({
      actorUserId,
      action: 'SHIFT_UPDATED',
      entityType: 'SHIFT',
      entityId: id,
      description: `Shift updated: ${updatedShift.name}`,
      metadata: {
        updatedFields: Object.keys(dto),
      },
    });

    return {
      message: 'Shift updated successfully',
      data: updatedShift,
    };
  }
}
