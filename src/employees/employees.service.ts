
import {
  Injectable,
  ConflictException,
  NotFoundException,
  ForbiddenException,
  BadRequestException, Logger,
} from '@nestjs/common';

import * as argon2 from 'argon2';

import { PrismaService } from '../prisma/prisma.service';
import {
  UserRole,
  UserStatus,
  ShiftStatus,
} from '../generated/prisma/client';

import { CreateEmployeeDto } from './dto/create-employee.dto';
import { GetEmployeesDto } from './dto/get-employees.dto';
import { UpdateEmployeeDto } from './dto/update-employee.dto';
import { AssignEmployeeShiftDto } from './dto/assign-employee-shift.dto';

import { AuditLogsService } from '../audit-logs/audit-logs.service';
import { EmployeeS3AvatarStorageService } from './employee-s3-avatar-storage.service';

interface EmployeeActor {
  sub: string;
  email: string;
  role: string;
  organizationId: string | null;
}

@Injectable()
export class EmployeesService {
  private readonly logger = new Logger(EmployeesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLogsService: AuditLogsService,
    private readonly employeeAvatarStorage: EmployeeS3AvatarStorageService,
  ) {}

  // Ensure the ADMIN belongs to an organization
  private getAdminOrganizationId(actor: EmployeeActor): string {
    if (actor.role !== 'ADMIN') {
      throw new ForbiddenException(
        'You are not allowed to perform this operation',
      );
    }

    if (!actor.organizationId) {
      throw new ForbiddenException(
        'Your account is not assigned to an organization',
      );
    }

    return actor.organizationId;
  }

  // Same-day, non-overlapping shifts only. Historical sessions keep their
  // own snapshot so later schedule edits do not rewrite an old attendance day.
  private async validateShiftIds(shiftIds: string[] | undefined, organizationId: string) {
    if (shiftIds === undefined) return [];
    if (!Array.isArray(shiftIds) || shiftIds.length < 1 || shiftIds.length > 24 ||
        new Set(shiftIds).size !== shiftIds.length) {
      throw new BadRequestException('Choose between 1 and 24 different shifts');
    }
    const shifts = await this.prisma.shift.findMany({
      where: { id: { in: shiftIds }, organizationId, status: ShiftStatus.ACTIVE },
    });
    if (shifts.length !== shiftIds.length) {
      throw new BadRequestException('All shifts must be active and belong to your organization');
    }
    const ranges = shiftIds.map(id => {
      const shift = shifts.find(item => item.id === id)!;
      const toMinutes = (time: string) => {
        if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) return NaN;
        const [h, m] = time.split(':').map(Number);
        return h * 60 + m;
      };
      const start = toMinutes(shift.startTime);
      const end = toMinutes(shift.endTime);
      if (!Number.isFinite(start) || !Number.isFinite(end) ||
          (shiftIds.length > 1 && end <= start)) {
        throw new BadRequestException('Multiple shifts must have valid same-day start/end times; overnight shifts are not supported yet');
      }
      return { id, start, end, name: shift.name };
    });
    for (let i = 0; i < ranges.length; i++) {
      if (i > 0 && ranges[i].start < ranges[i - 1].end) {
        throw new BadRequestException('Shifts must be selected in chronological order and must not overlap');
      }
    }
    return ranges;
  }

  private getTodayIndiaWorkDate(): Date {
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit',
    }).formatToParts(new Date());
    const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
    return new Date(`${values.year}-${values.month}-${values.day}T00:00:00.000Z`);
  }

  private async updateShiftAssignments(employeeProfileId: string, shiftIds: string[]) {
    // A transaction makes removal/reassignment of the whole ordered list atomic.
    await this.prisma.$transaction(async tx => {
      const active = await tx.attendanceSession.findFirst({
        where: { attendanceRecord: { employeeProfileId }, punchOutAt: null,
          approvalStatus: { in: ['PENDING', 'APPROVED', 'NOT_REQUIRED'] } },
        select: { id: true },
      });
      if (active) throw new ConflictException('Finish or review the open attendance session before changing shifts');
      const attendanceToday = await tx.attendanceRecord.findUnique({
        where: { employeeProfileId_workDate: { employeeProfileId, workDate: this.getTodayIndiaWorkDate() } },
        include: { sessions: { select: { id: true }, take: 1 } },
      });
      if (attendanceToday?.sessions.length) {
        throw new ConflictException('Cannot change assigned shifts after attendance has started today. Try on a future workday.');
      }
      await tx.employeeShiftAssignment.deleteMany({ where: { employeeProfileId } });
      await tx.employeeShiftAssignment.createMany({
        data: shiftIds.map((shiftId, index) => ({ employeeProfileId, shiftId, sequence: index + 1 })),
      });
      await tx.employeeProfile.update({
        where: { id: employeeProfileId }, data: { shiftId: shiftIds[0] },
      });
    });
  }

  private validateAvatarFile(file: { buffer: Buffer; size: number; mimetype: string } | undefined) {
    if (!file || !file.buffer || file.size < 1 || file.size > 1024 * 1024) {
      throw new BadRequestException('Choose an image up to 1 MB');
    }
    const data = file.buffer;
    const jpeg = data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff;
    const png = data.length >= 8 && data.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]));
    const webp = data.length >= 12 && data.subarray(0, 4).toString() === 'RIFF' && data.subarray(8, 12).toString() === 'WEBP';
    const mimeType = jpeg ? 'image/jpeg' : png ? 'image/png' : webp ? 'image/webp' : null;
    if (!mimeType || mimeType !== file.mimetype) {
      throw new BadRequestException('Only valid JPEG, PNG or WebP images can be uploaded');
    }
    return mimeType;
  }

  private async requireEmployeeForAvatar(id: string, actor: EmployeeActor) {
    if (!['ADMIN', 'SUPER_ADMIN'].includes(actor.role)) throw new ForbiddenException('Not authorized');
    const employee = await this.prisma.user.findFirst({
      where: { id, role: UserRole.EMPLOYEE,
        ...(actor.role === 'ADMIN' ? { organizationId: this.getAdminOrganizationId(actor) } : {}) },
      select: { employeeProfile: { select: { id: true } } },
    });
    if (!employee?.employeeProfile) throw new NotFoundException('Employee not found');
    return employee.employeeProfile.id;
  }

  async uploadEmployeeAvatar(id: string, actor: EmployeeActor, file: {buffer: Buffer; size: number; mimetype: string}) {
    const mimeType = this.validateAvatarFile(file);
    // Verify the admin's organization ownership *before* writing to S3.
    const employeeProfileId = await this.requireEmployeeForAvatar(id, actor);
    const profile = await this.prisma.employeeProfile.findUniqueOrThrow({
      where: { id: employeeProfileId }, select: { avatarUrl: true },
    });

    const uploadedUrl = await this.employeeAvatarStorage.upload(id, file.buffer, mimeType);
    try {
      // Keep the URL update and removal of legacy DB bytes atomic.
      await this.prisma.$transaction([
        this.prisma.employeeProfile.update({
          where: { id: employeeProfileId }, data: { avatarUrl: uploadedUrl },
        }),
        this.prisma.employeeAvatar.deleteMany({ where: { employeeProfileId } }),
      ]);
    } catch (error) {
      // Do not leave an S3 object if the PostgreSQL update failed.
      try { await this.employeeAvatarStorage.deleteManaged(uploadedUrl); }
      catch (cleanupError) { this.logger.warn(`S3 upload rollback failed: ${String(cleanupError)}`); }
      throw error;
    }

    // Delete the superseded image only *after* PostgreSQL points to the new one.
    if (profile.avatarUrl && profile.avatarUrl !== uploadedUrl) {
      try { await this.employeeAvatarStorage.deleteManaged(profile.avatarUrl); }
      catch (error) { this.logger.warn(`Old S3 employee photo cleanup failed: ${String(error)}`); }
    }
    return { message: 'Profile image uploaded successfully', avatarUrl: uploadedUrl };
  }

  // Employee self-service: read only the photo linked to the authenticated user.
  async getOwnAvatar(actor: EmployeeActor) {
    if (actor.role !== 'EMPLOYEE') throw new ForbiddenException('Not authorized');
    const profile = await this.prisma.employeeProfile.findFirst({
      where: { userId: actor.sub },
      select: { id: true },
    });
    if (!profile) throw new NotFoundException('Employee profile not found');
    return this.readAvatarByProfileId(profile.id);
  }

  async getEmployeeAvatar(id: string, actor: EmployeeActor) {
    const employeeProfileId = await this.requireEmployeeForAvatar(id, actor);
    return this.readAvatarByProfileId(employeeProfileId);
  }

  private async readAvatarByProfileId(employeeProfileId: string) {
    const profile = await this.prisma.employeeProfile.findUnique({
      where: { id: employeeProfileId }, select: { avatarUrl: true },
    });
    if (profile?.avatarUrl && this.employeeAvatarStorage.isManagedUrl(profile.avatarUrl)) {
      return this.employeeAvatarStorage.read(profile.avatarUrl);
    }
    // Preserve access to any photos still stored in the legacy DB table.
    const legacy = await this.prisma.employeeAvatar.findUnique({ where: { employeeProfileId } });
    if (!legacy) throw new NotFoundException('No uploaded image for this employee');
    return { content: Buffer.from(legacy.content), mimeType: legacy.mimeType };
  }

  // Create employee
  async createEmployee(
    dto: CreateEmployeeDto,
    actor: EmployeeActor,
  ) {
    const organizationId = this.getAdminOrganizationId(actor);

    const email = dto.email.trim().toLowerCase();
    const employeeCode = dto.employeeCode.trim().toUpperCase();
    const phone = dto.phone?.trim() || undefined;

    const existingEmail = await this.prisma.user.findUnique({
      where: { email },
    });

    if (existingEmail) {
      throw new ConflictException('Email is already registered');
    }

    const existingCode = await this.prisma.employeeProfile.findUnique({
      where: { employeeCode },
    });

    if (existingCode) {
      throw new ConflictException('Employee code is already registered');
    }

    if (phone) {
      const existingPhone = await this.prisma.employeeProfile.findUnique({
        where: { phone },
      });

      const existingAdminPhone = await this.prisma.adminProfile.findUnique({
        where: { phone },
      });

      if (existingPhone || existingAdminPhone) {
        throw new ConflictException('Phone number is already registered');
      }
    }

    // Department must belong to the ADMIN's organization
    if (dto.departmentId) {
      const department = await this.prisma.department.findFirst({
        where: {
          id: dto.departmentId,
          organizationId,
        },
      });

      if (!department) {
        throw new NotFoundException(
          'Department not found in your organization',
        );
      }
    }

    await this.validateShiftIds(dto.shiftIds, organizationId);

    const passwordHash = await argon2.hash(dto.password);

    const employee = await this.prisma.user.create({
      data: {
        email,
        passwordHash,
        role: UserRole.EMPLOYEE,
        status: UserStatus.ACTIVE,
        organizationId,

        employeeProfile: {
          create: {
            employeeCode,
            firstName: dto.firstName.trim(),
            lastName: dto.lastName.trim(),
            phone,
            designation: dto.designation?.trim(),
            departmentId: dto.departmentId,
            joiningDate: dto.joiningDate
              ? new Date(dto.joiningDate)
              : undefined,
            ...(dto.shiftIds?.length ? {
              shiftId: dto.shiftIds[0],
              shiftAssignments: {
                create: dto.shiftIds.map((shiftId, index) => ({ shiftId, sequence: index + 1 })),
              },
            } : {}),
          },
        },
      },
      select: {
        id: true,
        email: true,
        role: true,
        status: true,
        organizationId: true,
        createdAt: true,
        employeeProfile: {
          select: {
            id: true,
            employeeCode: true,
            firstName: true,
            lastName: true,
            phone: true,
            designation: true,
            joiningDate: true,
            avatarUrl: true,
            departmentId: true,
            shiftAssignments: { orderBy: { sequence: 'asc' }, include: { shift: true } },
          },
        },
      },
    });

    await this.auditLogsService.createLog({
      actorUserId: actor.sub,
      action: 'EMPLOYEE_CREATED',
      entityType: 'EMPLOYEE',
      entityId: employee.id,
      description: `Employee ${employee.email} was created`,
    });

    return {
      message: 'Employee created successfully',
      employee,
    };
  }

  // Get employees
  async getEmployees(
    query: GetEmployeesDto,
    actor: EmployeeActor,
  ) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 10;
    const skip = (page - 1) * limit;

    const search = query.search?.trim();

    const organizationFilter =
      actor.role === 'ADMIN'
        ? {
            organizationId: this.getAdminOrganizationId(actor),
          }
        : {};

    const where = {
      role: UserRole.EMPLOYEE,
      ...organizationFilter,

      ...(query.status && {
        status: query.status,
      }),

      ...(query.departmentId && {
        employeeProfile: {
          is: {
            departmentId: query.departmentId,
          },
        },
      }),

      ...(search && {
        OR: [
          {
            email: {
              contains: search,
              mode: 'insensitive' as const,
            },
          },
          {
            employeeProfile: {
              is: {
                firstName: {
                  contains: search,
                  mode: 'insensitive' as const,
                },
              },
            },
          },
          {
            employeeProfile: {
              is: {
                lastName: {
                  contains: search,
                  mode: 'insensitive' as const,
                },
              },
            },
          },
          {
            employeeProfile: {
              is: {
                employeeCode: {
                  contains: search,
                  mode: 'insensitive' as const,
                },
              },
            },
          },
        ],
      }),
    };

    const now = new Date();

    const [employees, total] = await this.prisma.$transaction([
      this.prisma.user.findMany({
        where,
        skip,
        take: limit,
        orderBy: {
          createdAt: 'desc',
        },
        select: {
          id: true,
          email: true,
          role: true,
          status: true,
          organizationId: true,
          createdAt: true,
          updatedAt: true,
          employeeProfile: {
            select: {
              id: true,
              employeeCode: true,
              firstName: true,
              lastName: true,
              phone: true,
              designation: true,
              joiningDate: true,
              avatarUrl: true,
              avatar: { select: { employeeProfileId: true } },
              shiftAssignments: { orderBy: { sequence: 'asc' }, include: { shift: true } },
              shiftId: true,

              department: {
                select: {
                  id: true,
                  name: true,
                },
              },

              shift: {
                select: {
                  id: true,
                  name: true,
                  startTime: true,
                  endTime: true,
                  status: true,
                },
              },

              workLocation: {
                select: {
                  id: true,
                  name: true,
                  type: true,
                  address: true,
                  status: true,
                },
              },

              temporaryLocationAssignments: {
                where: {
                  startAt: { lte: now },
                  endAt: { gt: now },
                  workLocation: {
                    status: 'ACTIVE',
                  },
                },
                orderBy: {
                  startAt: 'desc',
                },
                take: 1,
                select: {
                  id: true,
                  startAt: true,
                  endAt: true,
                  reason: true,
                  workLocation: {
                    select: {
                      id: true,
                      name: true,
                      type: true,
                      address: true,
                      status: true,
                    },
                  },
                },
              },
            },
          },
        },
      }),

      this.prisma.user.count({
        where,
      }),
    ]);

    return {
      data: employees,
      pagination: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  // Get employee by ID
  async getEmployeeById(
    id: string,
    actor: EmployeeActor,
  ) {
    const organizationFilter =
      actor.role === 'ADMIN'
        ? {
            organizationId: this.getAdminOrganizationId(actor),
          }
        : {};

    const employee = await this.prisma.user.findFirst({
      where: {
        id,
        role: UserRole.EMPLOYEE,
        ...organizationFilter,
      },
      select: {
        id: true,
        email: true,
        role: true,
        status: true,
        organizationId: true,
        createdAt: true,
        updatedAt: true,
        employeeProfile: {
          select: {
            id: true,
            employeeCode: true,
            firstName: true,
            lastName: true,
            phone: true,
            designation: true,
            joiningDate: true,
            avatarUrl: true,
            avatar: { select: { employeeProfileId: true } },
            shiftAssignments: { orderBy: { sequence: 'asc' }, include: { shift: true } },
            shiftId: true,

            department: {
              select: {
                id: true,
                name: true,
              },
            },

            shift: {
              select: {
                id: true,
                name: true,
                startTime: true,
                endTime: true,
                gracePeriodMinutes: true,
                lateReasonAfterMinutes: true,
                approvalRequiredAfterMinutes: true,
                status: true,
              },
            },
          },
        },
      },
    });

    if (!employee) {
      throw new NotFoundException('Employee not found');
    }

    return {
      message: 'Employee retrieved successfully',
      data: employee,
    };
  }

  // Update employee
  async updateEmployee(
    id: string,
    dto: UpdateEmployeeDto,
    actor: EmployeeActor,
  ) {
    const organizationId = this.getAdminOrganizationId(actor);

    const existingEmployee = await this.prisma.user.findFirst({
      where: {
        id,
        role: UserRole.EMPLOYEE,
        organizationId,
      },
      select: {
        id: true,
        email: true,
        employeeProfile: {
          select: {
            id: true,
          },
        },
      },
    });

    if (!existingEmployee || !existingEmployee.employeeProfile) {
      throw new NotFoundException('Employee not found');
    }

    if (dto.email && dto.email.trim().toLowerCase() !== existingEmployee.email) {
      const emailExists = await this.prisma.user.findUnique({
        where: {
          email: dto.email.trim().toLowerCase(),
        },
      });

      if (emailExists) {
        throw new ConflictException('Email is already registered');
      }
    }

    if (dto.departmentId) {
      const department = await this.prisma.department.findFirst({
        where: {
          id: dto.departmentId,
          organizationId,
        },
      });

      if (!department) {
        throw new NotFoundException(
          'Department not found in your organization',
        );
      }
    }

    if (dto.shiftIds !== undefined) {
      await this.validateShiftIds(dto.shiftIds, organizationId);
    }

    const {
      email,
      departmentId,
      joiningDate,
      firstName,
      lastName,
      phone,
      designation,
    } = dto;

    const employee = await this.prisma.$transaction(async tx => {
      if (dto.shiftIds !== undefined) {
        const open = await tx.attendanceSession.findFirst({
          where: { attendanceRecord: { employeeProfileId: existingEmployee.employeeProfile!.id },
            punchOutAt: null, approvalStatus: { in: ['PENDING', 'NOT_REQUIRED', 'APPROVED'] } },
          select: { id: true },
        });
        if (open) throw new ConflictException('Finish or review the open attendance session before changing shifts');
        const attendanceToday = await tx.attendanceRecord.findUnique({
          where: { employeeProfileId_workDate: {
            employeeProfileId: existingEmployee.employeeProfile!.id, workDate: this.getTodayIndiaWorkDate(),
          } }, include: { sessions: { select: { id: true }, take: 1 } },
        });
        if (attendanceToday?.sessions.length) throw new ConflictException(
          'Cannot change assigned shifts after attendance has started today. Try on a future workday.');
        await tx.employeeShiftAssignment.deleteMany({ where: { employeeProfileId: existingEmployee.employeeProfile!.id } });
        await tx.employeeShiftAssignment.createMany({
          data: dto.shiftIds.map((shiftId, index) => ({
            employeeProfileId: existingEmployee.employeeProfile!.id,
            shiftId, sequence: index + 1,
          })),
        });
        await tx.employeeProfile.update({
          where: { id: existingEmployee.employeeProfile!.id }, data: { shiftId: dto.shiftIds[0] },
        });
      }
      return tx.user.update({
      where: {
        id,
      },
      data: {
        ...(email !== undefined && {
          email: email.trim().toLowerCase(),
        }),

        employeeProfile: {
          update: {
            ...(firstName !== undefined && { firstName }),
            ...(lastName !== undefined && { lastName }),
            ...(phone !== undefined && { phone }),
            ...(designation !== undefined && { designation }),

            ...(joiningDate !== undefined && {
              joiningDate: new Date(joiningDate),
            }),

            ...(departmentId !== undefined && {
              department: departmentId
                ? { connect: { id: departmentId } }
                : { disconnect: true },
            }),
          },
        },
      },
      select: {
        id: true,
        email: true,
        role: true,
        status: true,
        organizationId: true,
        createdAt: true,
        updatedAt: true,
        employeeProfile: {
          select: {
            id: true,
            employeeCode: true,
            firstName: true,
            lastName: true,
            phone: true,
            designation: true,
            joiningDate: true,
            avatarUrl: true,
            department: {
              select: {
                id: true,
                name: true,
              },
            },
          },
        },
      },
    });
    });

    await this.auditLogsService.createLog({
      actorUserId: actor.sub,
      action: 'EMPLOYEE_UPDATED',
      entityType: 'EMPLOYEE',
      entityId: employee.id,
      description: `Employee ${employee.email} was updated`,
    });

    return {
      message: 'Employee updated successfully',
      data: employee,
    };
  }

  // Deactivate employee
  async deactivateEmployee(
    id: string,
    actor: EmployeeActor,
  ) {
    const organizationId = this.getAdminOrganizationId(actor);

    const employee = await this.prisma.user.findFirst({
      where: {
        id,
        role: UserRole.EMPLOYEE,
        organizationId,
      },
      select: {
        id: true,
        status: true,
      },
    });

    if (!employee) {
      throw new NotFoundException('Employee not found');
    }

    if (employee.status === UserStatus.INACTIVE) {
      throw new ConflictException('Employee is already inactive');
    }

    const updatedEmployee = await this.prisma.user.update({
      where: {
        id,
      },
      data: {
        status: UserStatus.INACTIVE,
        refreshTokenHash: null,
      },
      select: {
        id: true,
        email: true,
        role: true,
        status: true,
      },
    });

    await this.auditLogsService.createLog({
      actorUserId: actor.sub,
      action: 'EMPLOYEE_DEACTIVATED',
      entityType: 'EMPLOYEE',
      entityId: updatedEmployee.id,
      description: `Employee ${updatedEmployee.email} was deactivated`,
    });

    return {
      message: 'Employee deactivated successfully',
      data: updatedEmployee,
    };
  }

  // Reactivate employee
  async reactivateEmployee(
    id: string,
    actor: EmployeeActor,
  ) {
    const organizationId = this.getAdminOrganizationId(actor);

    const employee = await this.prisma.user.findFirst({
      where: {
        id,
        role: UserRole.EMPLOYEE,
        organizationId,
      },
      select: {
        id: true,
        status: true,
      },
    });

    if (!employee) {
      throw new NotFoundException('Employee not found');
    }

    if (employee.status === UserStatus.ACTIVE) {
      throw new ConflictException('Employee is already active');
    }

    const updatedEmployee = await this.prisma.user.update({
      where: {
        id,
      },
      data: {
        status: UserStatus.ACTIVE,
      },
      select: {
        id: true,
        email: true,
        role: true,
        status: true,
      },
    });

    await this.auditLogsService.createLog({
      actorUserId: actor.sub,
      action: 'EMPLOYEE_REACTIVATED',
      entityType: 'EMPLOYEE',
      entityId: updatedEmployee.id,
      description: `Employee ${updatedEmployee.email} was reactivated`,
    });

    return {
      message: 'Employee reactivated successfully',
      data: updatedEmployee,
    };
  }

  // Assign employee shift
  async assignEmployeeShift(
    id: string,
    dto: AssignEmployeeShiftDto,
    actor: EmployeeActor,
  ) {
    const organizationId = this.getAdminOrganizationId(actor);

    const employee = await this.prisma.user.findFirst({
      where: {
        id,
        role: UserRole.EMPLOYEE,
        organizationId,
      },
      include: {
        employeeProfile: true,
      },
    });

    if (!employee || !employee.employeeProfile) {
      throw new NotFoundException('Employee not found');
    }

    // Shift must belong to the same organization
    const shift = await this.prisma.shift.findFirst({
      where: {
        id: dto.shiftId,
        organizationId,
      },
    });

    if (!shift) {
      throw new NotFoundException(
        'Shift not found in your organization',
      );
    }

    if (shift.status !== ShiftStatus.ACTIVE) {
      throw new ConflictException(
        'Cannot assign an inactive shift',
      );
    }

    await this.validateShiftIds([dto.shiftId], organizationId);
    await this.updateShiftAssignments(employee.employeeProfile.id, [dto.shiftId]);
    const updatedEmployee = await this.prisma.employeeProfile.findUnique({
      where: {
        userId: id,
      },
      include: {
        user: {
          select: {
            id: true,
            email: true,
            role: true,
            status: true,
            organizationId: true,
          },
        },
        shift: true,
        department: true,
      },
    });

    await this.auditLogsService.createLog({
      actorUserId: actor.sub,
      action: 'EMPLOYEE_SHIFT_ASSIGNED',
      entityType: 'EMPLOYEE',
      entityId: id,
      description: `A shift was assigned to employee ${id}`,
      metadata: {
        shiftId: dto.shiftId,
      },
    });

    return {
      message: 'Employee shift assigned successfully',
      data: updatedEmployee,
    };
  }
}
