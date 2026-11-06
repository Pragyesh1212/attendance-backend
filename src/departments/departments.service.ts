
import {
  Injectable,
  ConflictException,
  NotFoundException,
  ForbiddenException,
  BadRequestException,
} from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service';
import { AuditLogsService } from '../audit-logs/audit-logs.service';

import { CreateDepartmentDto } from './dto/create-department.dto';
import { UpdateDepartmentDto } from './dto/update-department.dto';

@Injectable()
export class DepartmentsService {
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

  async createDepartment(
    dto: CreateDepartmentDto,
    actorUserId: string,
  ) {
    const organizationId =
      await this.getAdminOrganization(actorUserId);

    const name = dto.name.trim();

    if (!name) {
      throw new BadRequestException(
        'Department name cannot be empty',
      );
    }

    const existing = await this.prisma.department.findFirst({
      where: {
        organizationId,
        name,
      },
    });

    if (existing) {
      throw new ConflictException(
        'Department already exists in your organization',
      );
    }

    const department = await this.prisma.department.create({
      data: {
        name,
        description: dto.description?.trim() || null,
        organizationId,
      },
      include: {
        _count: {
          select: { employees: true },
        },
      },
    });

    await this.auditLogsService.createLog({
      actorUserId,
      action: 'DEPARTMENT_CREATED',
      entityType: 'DEPARTMENT',
      entityId: department.id,
      description: `Department created: ${department.name}`,
    });

    return {
      message: 'Department created successfully',
      data: department,
    };
  }

  async getDepartments(
    actorUserId: string,
    role: string,
  ) {
    const organizationId =
      role === 'ADMIN'
        ? await this.getAdminOrganization(actorUserId)
        : undefined;

    const departments = await this.prisma.department.findMany({
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
      message: 'Departments retrieved successfully',
      data: departments,
      total: departments.length,
    };
  }

  async getDepartmentById(
    id: string,
    actorUserId: string,
    role: string,
  ) {
    const organizationId =
      role === 'ADMIN'
        ? await this.getAdminOrganization(actorUserId)
        : undefined;

    const department = await this.prisma.department.findFirst({
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

    if (!department) {
      throw new NotFoundException('Department not found');
    }

    return {
      message: 'Department retrieved successfully',
      data: department,
    };
  }

  async updateDepartment(
    id: string,
    dto: UpdateDepartmentDto,
    actorUserId: string,
  ) {
    const organizationId =
      await this.getAdminOrganization(actorUserId);

    const department = await this.prisma.department.findFirst({
      where: {
        id,
        organizationId,
      },
    });

    if (!department) {
      throw new NotFoundException(
        'Department not found in your organization',
      );
    }

    const name = dto.name?.trim();

    if (dto.name !== undefined && !name) {
      throw new BadRequestException(
        'Department name cannot be empty',
      );
    }

    if (name && name !== department.name) {
      const duplicate = await this.prisma.department.findFirst({
        where: {
          organizationId,
          name,
          id: { not: id },
        },
      });

      if (duplicate) {
        throw new ConflictException(
          'Department name already exists in your organization',
        );
      }
    }

    const updatedDepartment =
      await this.prisma.department.update({
        where: { id },
        data: {
          ...(name !== undefined && { name }),
          ...(dto.description !== undefined && {
            description: dto.description.trim() || null,
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
      action: 'DEPARTMENT_UPDATED',
      entityType: 'DEPARTMENT',
      entityId: id,
      description: `Department updated: ${updatedDepartment.name}`,
      metadata: {
        updatedFields: Object.keys(dto),
      },
    });

    return {
      message: 'Department updated successfully',
      data: updatedDepartment,
    };
  }
}
