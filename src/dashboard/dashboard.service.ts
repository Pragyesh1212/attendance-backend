
import {
  Injectable,
  ForbiddenException,
} from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class DashboardService {
  constructor(private readonly prisma: PrismaService) {}

  // India calendar date boundaries
  private getIndiaDateRange(date = new Date()) {
    const indiaTime = new Date(
      date.toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }),
    );

    const start = new Date(
      Date.UTC(
        indiaTime.getFullYear(),
        indiaTime.getMonth(),
        indiaTime.getDate(),
      ),
    );

    const end = new Date(start);
    end.setUTCDate(end.getUTCDate() + 1);

    return { start, end };
  }

  // Dashboard overview for Admin and Super Admin
  async getOverview() {
    const { start, end } = this.getIndiaDateRange();

    const [
      totalEmployees,
      totalAdmins,
      attendanceToday,
      pendingApprovals,
      pendingCorrections,
    ] = await Promise.all([
      this.prisma.employeeProfile.count({
        where: {
          user: { status: 'ACTIVE' },
        },
      }),

      this.prisma.user.count({
        where: {
          role: 'ADMIN',
          status: 'ACTIVE',
        },
      }),

      this.prisma.attendanceRecord.findMany({
        where: {
          workDate: { gte: start, lt: end },
        },
        select: {
          status: true,
        },
      }),

      this.prisma.attendanceSession.count({
        where: {
          approvalStatus: 'PENDING',
        },
      }),

      this.prisma.attendanceCorrectionRequest.count({
        where: {
          status: 'PENDING',
        },
      }),
    ]);

    const present = attendanceToday.filter(
      (record) => record.status === 'PRESENT',
    ).length;

    const late = attendanceToday.filter(
      (record) => record.status === 'LATE',
    ).length;

    const halfDay = attendanceToday.filter(
      (record) => record.status === 'HALF_DAY',
    ).length;

    const absent = attendanceToday.filter(
      (record) => record.status === 'ABSENT',
    ).length;

    const onLeave = attendanceToday.filter(
      (record) => record.status === 'ON_LEAVE',
    ).length;

    const attended = present + late + halfDay;

    const attendancePercentage =
      totalEmployees > 0
        ? Number(((attended / totalEmployees) * 100).toFixed(2))
        : 0;

    return {
      totalEmployees,
      totalAdmins,
      attendance: {
        present,
        late,
        halfDay,
        absent,
        onLeave,
        notMarked: Math.max(
          totalEmployees - attendanceToday.length,
          0,
        ),
        attendancePercentage,
      },
      pendingApprovals,
      pendingCorrections,
    };
  }

  // Monthly attendance trend
  async getAttendanceTrend(month?: number, year?: number) {
    const now = new Date();

    const selectedMonth = month ?? now.getMonth() + 1;
    const selectedYear = year ?? now.getFullYear();

    if (
      !Number.isInteger(selectedMonth) ||
      selectedMonth < 1 ||
      selectedMonth > 12 ||
      !Number.isInteger(selectedYear) ||
      selectedYear < 2000 ||
      selectedYear > 2100
    ) {
      throw new ForbiddenException('Invalid month or year');
    }

    const start = new Date(
      Date.UTC(selectedYear, selectedMonth - 1, 1),
    );

    const end = new Date(
      Date.UTC(selectedYear, selectedMonth, 1),
    );

    const records = await this.prisma.attendanceRecord.findMany({
      where: {
        workDate: {
          gte: start,
          lt: end,
        },
      },
      select: {
        workDate: true,
        status: true,
      },
      orderBy: {
        workDate: 'asc',
      },
    });

    const dailyStats = new Map<string, {
      present: number;
      late: number;
      absent: number;
      halfDay: number;
      onLeave: number;
    }>();

    for (const record of records) {
      const dateKey = record.workDate.toISOString().slice(0, 10);

      if (!dailyStats.has(dateKey)) {
        dailyStats.set(dateKey, {
          present: 0,
          late: 0,
          absent: 0,
          halfDay: 0,
          onLeave: 0,
        });
      }

      const stats = dailyStats.get(dateKey)!;

      switch (record.status) {
        case 'PRESENT':
          stats.present++;
          break;
        case 'LATE':
          stats.late++;
          break;
        case 'ABSENT':
          stats.absent++;
          break;
        case 'HALF_DAY':
          stats.halfDay++;
          break;
        case 'ON_LEAVE':
          stats.onLeave++;
          break;
      }
    }

    return {
      month: selectedMonth,
      year: selectedYear,
      trend: Array.from(dailyStats.entries()).map(
        ([date, stats]) => ({
          date,
          ...stats,
        }),
      ),
    };
  }

  // Department-wise attendance statistics
  async getDepartmentStats() {
    const { start, end } = this.getIndiaDateRange();

    const departments = await this.prisma.department.findMany({
      include: {
        employees: {
          where: {
            user: { status: 'ACTIVE' },
          },
          include: {
            attendanceRecords: {
              where: {
                workDate: {
                  gte: start,
                  lt: end,
                },
              },
              select: {
                status: true,
              },
            },
          },
        },
      },
      orderBy: {
        name: 'asc',
      },
    });

    return departments.map((department) => {
      const employees = department.employees;

      const present = employees.reduce(
        (total, employee) =>
          total +
          employee.attendanceRecords.filter(
            (record) => record.status === 'PRESENT',
          ).length,
        0,
      );

      const late = employees.reduce(
        (total, employee) =>
          total +
          employee.attendanceRecords.filter(
            (record) => record.status === 'LATE',
          ).length,
        0,
      );

      const absent = employees.reduce(
        (total, employee) =>
          total +
          employee.attendanceRecords.filter(
            (record) => record.status === 'ABSENT',
          ).length,
        0,
      );

      const halfDay = employees.reduce(
        (total, employee) =>
          total +
          employee.attendanceRecords.filter(
            (record) => record.status === 'HALF_DAY',
          ).length,
        0,
      );

      return {
        departmentId: department.id,
        departmentName: department.name,
        totalEmployees: employees.length,
        present,
        late,
        absent,
        halfDay,
      };
    });
  }

  // Employee personal dashboard
  async getMyStats(userId: string) {
    const employee = await this.prisma.employeeProfile.findUnique({
      where: {
        userId,
      },
      include: {
        attendanceRecords: {
          orderBy: {
            workDate: 'desc',
          },
          take: 100,
          include: {
            sessions: {
              orderBy: {
                punchInAt: 'desc',
              },
            },
          },
        },
      },
    });

    if (!employee) {
      throw new ForbiddenException(
        'Employee profile not found',
      );
    }

    const records = employee.attendanceRecords;

    const present = records.filter(
      (record) => record.status === 'PRESENT',
    ).length;

    const late = records.filter(
      (record) => record.status === 'LATE',
    ).length;

    const absent = records.filter(
      (record) => record.status === 'ABSENT',
    ).length;

    const halfDay = records.filter(
      (record) => record.status === 'HALF_DAY',
    ).length;

    const onLeave = records.filter(
      (record) => record.status === 'ON_LEAVE',
    ).length;

    const totalWorkMinutes = records.reduce(
      (total, record) => total + record.totalWorkMinutes,
      0,
    );

    const attendedDays = present + late + halfDay;

    const attendancePercentage =
      records.length > 0
        ? Number(
            ((attendedDays / records.length) * 100).toFixed(2),
          )
        : 0;

    return {
      employee: {
        id: employee.id,
        employeeCode: employee.employeeCode,
        firstName: employee.firstName,
        lastName: employee.lastName,
      },
      summary: {
        totalRecordedDays: records.length,
        present,
        late,
        absent,
        halfDay,
        onLeave,
        totalWorkMinutes,
        totalWorkHours: Number(
          (totalWorkMinutes / 60).toFixed(2),
        ),
        attendancePercentage,
      },
      recentAttendance: records.slice(0, 10),
    };
  }
}
