
import {
  Injectable,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';

import * as argon2 from 'argon2';

import { PrismaService } from '../prisma/prisma.service';
import { AuditLogsService } from '../audit-logs/audit-logs.service';

import {
  UserRole,
  UserStatus,
} from '../generated/prisma/client';

import { CreateAdminDto } from './dto/create-admin.dto';
import { GetAdminsDto } from './dto/get-admins.dto';
import { UpdateAdminDto } from './dto/update-admin.dto';

@Injectable()
export class AdminsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLogsService: AuditLogsService,
  ) {}

  async createAdmin(dto: CreateAdminDto, actorUserId?: string) {
    const email = dto.email.trim().toLowerCase();
    const firstName = dto.firstName.trim();
    const lastName = dto.lastName.trim();
    const phone = dto.phone?.trim() || null;
    const designation = dto.designation?.trim() || null;

    const existingUser = await this.prisma.user.findUnique({
      where: { email },
    });

    if (existingUser) {
      throw new ConflictException(
        'An account with this email already exists',
      );
    }

    if (phone) {
      const existingAdminPhone =
        await this.prisma.adminProfile.findUnique({
          where: { phone },
        });

      const existingEmployeePhone =
        await this.prisma.employeeProfile.findUnique({
          where: { phone },
        });

      if (existingAdminPhone || existingEmployeePhone) {
        throw new ConflictException('Phone number is already in use');
      }
    }

    const organization = await this.prisma.organization.findFirst({
      where: {
        id: dto.organizationId,
        status: 'ACTIVE',
      },
      select: { id: true },
    });

    if (!organization) {
      throw new NotFoundException('Active organization not found');
    }

    const passwordHash = await argon2.hash(dto.password);

    const admin = await this.prisma.user.create({
      data: {
        email,
        passwordHash,
        role: UserRole.ADMIN,
        status: UserStatus.ACTIVE,
        emailVerifiedAt: null,
        organizationId: organization.id,
        adminProfile: {
          create: {
            firstName,
            lastName,
            phone,
            designation,
          },
        },
      },
      select: {
        id: true,
        email: true,
        role: true,
        status: true,
        organizationId: true,
        organization: {
          select: {
            id: true,
            name: true,
          },
        },
        createdAt: true,
        adminProfile: {
          select: {
            firstName: true,
            lastName: true,
            phone: true,
            designation: true,
            avatarUrl: true,
          },
        },
      },
    });

    await this.auditLogsService.createLog({
      actorUserId,
      action: 'ADMIN_CREATED',
      entityType: 'ADMIN',
      entityId: admin.id,
      description: `Admin account created: ${admin.email}`,
      metadata: {
        firstName,
        lastName,
        designation,
        organizationId: organization.id,
      },
    });

    return {
      message: 'Admin account created successfully',
      admin,
    };
  }

  async getAdmins(query: GetAdminsDto) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 10;
    const skip = (page - 1) * limit;

    const where = {
      role: UserRole.ADMIN,

      ...(query.status
        ? { status: query.status }
        : {}),

      ...(query.organizationId
        ? { organizationId: query.organizationId }
        : {}),

      ...(query.search?.trim()
        ? {
            OR: [
              {
                email: {
                  contains: query.search.trim(),
                  mode: 'insensitive' as const,
                },
              },
              {
                adminProfile: {
                  is: {
                    firstName: {
                      contains: query.search.trim(),
                      mode: 'insensitive' as const,
                    },
                  },
                },
              },
              {
                adminProfile: {
                  is: {
                    lastName: {
                      contains: query.search.trim(),
                      mode: 'insensitive' as const,
                    },
                  },
                },
              },
            ],
          }
        : {}),
    };

    const [admins, total] = await this.prisma.$transaction([
      this.prisma.user.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          email: true,
          role: true,
          status: true,
          organizationId: true,
          organization: {
            select: {
              id: true,
              name: true,
            },
          },
          createdAt: true,
          updatedAt: true,
          adminProfile: {
            select: {
              firstName: true,
              lastName: true,
              phone: true,
              designation: true,
              avatarUrl: true,
            },
          },
        },
      }),

      this.prisma.user.count({ where }),
    ]);

    return {
      data: admins,
      pagination: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  async getAdminById(id: string) {
    const admin = await this.prisma.user.findFirst({
      where: {
        id,
        role: UserRole.ADMIN,
      },
      select: {
        id: true,
        email: true,
        role: true,
        status: true,
        organizationId: true,
        organization: {
          select: {
            id: true,
            name: true,
          },
        },
        emailVerifiedAt: true,
        lastLoginAt: true,
        createdAt: true,
        updatedAt: true,
        adminProfile: {
          select: {
            firstName: true,
            lastName: true,
            phone: true,
            designation: true,
            avatarUrl: true,
          },
        },
      },
    });

    if (!admin) {
      throw new NotFoundException('Admin account not found');
    }

    return { data: admin };
  }

  async updateAdmin(
    id: string,
    dto: UpdateAdminDto,
    actorUserId?: string,
  ) {
    const existingAdmin = await this.prisma.user.findFirst({
      where: {
        id,
        role: UserRole.ADMIN,
      },
      include: {
        adminProfile: true,
      },
    });

    if (!existingAdmin) {
      throw new NotFoundException('Admin account not found');
    }

    const email = dto.email?.trim().toLowerCase();
    const phone =
      dto.phone !== undefined
        ? dto.phone.trim() || null
        : undefined;

    // Validate email uniqueness.
    if (email && email !== existingAdmin.email) {
      const existingEmail = await this.prisma.user.findUnique({
        where: { email },
      });

      if (existingEmail) {
        throw new ConflictException('Email is already in use');
      }
    }

    // Validate phone uniqueness.
    if (phone) {
      const existingAdminPhone =
        await this.prisma.adminProfile.findFirst({
          where: {
            phone,
            userId: { not: id },
          },
        });

      const existingEmployeePhone =
        await this.prisma.employeeProfile.findUnique({
          where: { phone },
        });

      if (existingAdminPhone || existingEmployeePhone) {
        throw new ConflictException('Phone number is already in use');
      }
    }

    // Validate the new organization.
    if (dto.organizationId !== undefined) {
      const organization =
        await this.prisma.organization.findFirst({
          where: {
            id: dto.organizationId,
            status: 'ACTIVE',
          },
          select: { id: true },
        });

      if (!organization) {
        throw new NotFoundException('Active organization not found');
      }
    }

    const hasProfileChanges =
      dto.firstName !== undefined ||
      dto.lastName !== undefined ||
      dto.phone !== undefined ||
      dto.designation !== undefined;

    await this.prisma.$transaction(async (tx) => {
      // Update user email.
      if (email) {
        await tx.user.update({
          where: { id },
          data: { email },
        });
      }

      // Update organization assignment.
      if (dto.organizationId !== undefined) {
        await tx.user.update({
          where: { id },
          data: {
            organizationId: dto.organizationId,
          },
        });
      }

      // Update admin profile without overwriting existing fields.
      if (hasProfileChanges) {
        await tx.adminProfile.upsert({
          where: { userId: id },

          create: {
            userId: id,
            firstName:
              dto.firstName?.trim() || 'Admin',
            lastName:
              dto.lastName?.trim() || 'User',
            phone: phone ?? null,
            designation:
              dto.designation?.trim() || null,
          },

          update: {
            ...(dto.firstName !== undefined && {
              firstName: dto.firstName.trim(),
            }),

            ...(dto.lastName !== undefined && {
              lastName: dto.lastName.trim(),
            }),

            ...(dto.phone !== undefined && {
              phone,
            }),

            ...(dto.designation !== undefined && {
              designation:
                dto.designation.trim() || null,
            }),
          },
        });
      }
    });

    // Fetch updated admin including organization.
    const updatedAdmin =
      await this.prisma.user.findUnique({
        where: { id },
        select: {
          id: true,
          email: true,
          role: true,
          status: true,
          organizationId: true,
          organization: {
            select: {
              id: true,
              name: true,
            },
          },
          createdAt: true,
          updatedAt: true,
          adminProfile: {
            select: {
              firstName: true,
              lastName: true,
              phone: true,
              designation: true,
              avatarUrl: true,
            },
          },
        },
      });

    await this.auditLogsService.createLog({
      actorUserId,
      action: 'ADMIN_UPDATED',
      entityType: 'ADMIN',
      entityId: id,
      description: `Admin account updated: ${updatedAdmin?.email ?? id}`,
      metadata: {
        updatedFields: Object.keys(dto),
      },
    });

    return {
      message: 'Admin account updated successfully',
      data: updatedAdmin,
    };
  }

  async deactivateAdmin(
    id: string,
    actorUserId?: string,
  ) {
    const admin = await this.prisma.user.findFirst({
      where: {
        id,
        role: UserRole.ADMIN,
      },
    });

    if (!admin) {
      throw new NotFoundException('Admin account not found');
    }

    if (admin.status === UserStatus.INACTIVE) {
      return {
        message: 'Admin account is already inactive',
      };
    }

    await this.prisma.user.update({
      where: { id },
      data: {
        status: UserStatus.INACTIVE,
        refreshTokenHash: null,
      },
    });

    await this.auditLogsService.createLog({
      actorUserId,
      action: 'ADMIN_DEACTIVATED',
      entityType: 'ADMIN',
      entityId: id,
      description: `Admin account deactivated: ${admin.email}`,
    });

    return {
      message: 'Admin account deactivated successfully',
    };
  }

  async reactivateAdmin(
    id: string,
    actorUserId?: string,
  ) {
    const admin = await this.prisma.user.findFirst({
      where: {
        id,
        role: UserRole.ADMIN,
      },
    });

    if (!admin) {
      throw new NotFoundException('Admin account not found');
    }

    if (admin.status === UserStatus.ACTIVE) {
      return {
        message: 'Admin account is already active',
      };
    }

    await this.prisma.user.update({
      where: { id },
      data: {
        status: UserStatus.ACTIVE,
      },
    });

    await this.auditLogsService.createLog({
      actorUserId,
      action: 'ADMIN_REACTIVATED',
      entityType: 'ADMIN',
      entityId: id,
      description: `Admin account reactivated: ${admin.email}`,
    });

    return {
      message: 'Admin account reactivated successfully',
    };
  }
}
