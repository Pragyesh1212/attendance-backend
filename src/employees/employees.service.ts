
import {
  Injectable,
  ConflictException,
  NotFoundException,
  ForbiddenException,
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

interface EmployeeActor {
  sub: string;
  email: string;
  role: string;
  organizationId: string | null;
}

@Injectable()
export class EmployeesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLogsService: AuditLogsService,
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
            avatarUrl: dto.avatarUrl,
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

    const {
      email,
      departmentId,
      joiningDate,
      firstName,
      lastName,
      phone,
      designation,
      avatarUrl,
    } = dto;

    const employee = await this.prisma.user.update({
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
            ...(avatarUrl !== undefined && { avatarUrl }),

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

    const updatedEmployee = await this.prisma.employeeProfile.update({
      where: {
        userId: id,
      },
      data: {
        shiftId: dto.shiftId,
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
