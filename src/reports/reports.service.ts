
import {
  Injectable,
  BadRequestException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

interface AttendanceReportFilters {
  startDate?: string;
  endDate?: string;
  employeeId?: string;
  departmentId?: string;
  status?: string;
}

@Injectable()
export class ReportsService {
  constructor(private readonly prisma: PrismaService) {}

  async getAttendanceReport(filters: AttendanceReportFilters) {
    const { startDate, endDate, employeeId, departmentId, status } = filters;

    if (startDate && isNaN(Date.parse(startDate))) {
      throw new BadRequestException('Invalid start date');
    }

    if (endDate && isNaN(Date.parse(endDate))) {
      throw new BadRequestException('Invalid end date');
    }

    if (startDate && endDate && startDate > endDate) {
      throw new BadRequestException(
        'Start date cannot be after end date',
      );
    }

    const validStatuses = [
      'PRESENT',
      'LATE',
      'HALF_DAY',
      'ABSENT',
      'ON_LEAVE',
    ];

    if (status && !validStatuses.includes(status)) {
      throw new BadRequestException('Invalid attendance status');
    }

    const where: any = {
      ...(startDate || endDate
        ? {
            workDate: {
              ...(startDate
                ? { gte: new Date(`${startDate}T00:00:00.000Z`) }
                : {}),
              ...(endDate
                ? { lte: new Date(`${endDate}T23:59:59.999Z`) }
                : {}),
            },
          }
        : {}),
      ...(status ? { status } : {}),
      ...(employeeId || departmentId
        ? {
            employeeProfile: {
              ...(employeeId ? { id: employeeId } : {}),
              ...(departmentId ? { departmentId } : {}),
            },
          }
        : {}),
    };

    const records = await this.prisma.attendanceRecord.findMany({
      where,
      include: {
        employeeProfile: {
          select: {
            employeeCode: true,
            firstName: true,
            lastName: true,
            department: {
              select: { name: true },
            },
            shift: {
              select: { name: true },
            },
          },
        },
        sessions: {
          orderBy: { punchInAt: 'asc' },
          select: {
            punchInAt: true,
            punchOutAt: true,
          },
        },
      },
      orderBy: [
        { workDate: 'desc' },
        { createdAt: 'desc' },
      ],
    });

    return {
      totalRecords: records.length,
      records: records.map((record) => ({
        id: record.id,
        workDate: record.workDate,
        employeeCode: record.employeeProfile.employeeCode,
        employeeName: `${record.employeeProfile.firstName} ${record.employeeProfile.lastName}`,
        department: record.employeeProfile.department?.name ?? 'N/A',
        shift: record.employeeProfile.shift?.name ?? 'N/A',
        status: record.status,
        totalWorkMinutes: record.totalWorkMinutes,
        totalWorkHours: Number(
          (record.totalWorkMinutes / 60).toFixed(2),
        ),
        sessions: record.sessions,
      })),
    };
  }

  async exportAttendanceCsv(filters: AttendanceReportFilters) {
    const report = await this.getAttendanceReport(filters);

    const headers = [
      'Date',
      'Employee Code',
      'Employee Name',
      'Department',
      'Shift',
      'Status',
      'Punch In',
      'Punch Out',
      'Working Hours',
    ];

    const escapeCsv = (value: unknown): string => {
      let text = value == null ? '' : String(value);

      // Protect spreadsheet users from formula injection.
      if (/^[=+\-@\t\r]/.test(text)) {
        text = `'${text}`;
      }

      return `"${text.replace(/"/g, '""')}"`;
    };

    const rows = report.records.map((record) => {
      const firstSession = record.sessions[0];
      const lastSession = record.sessions[record.sessions.length - 1];

      return [
        new Date(record.workDate).toISOString().slice(0, 10),
        record.employeeCode,
        record.employeeName,
        record.department,
        record.shift,
        record.status,
        firstSession?.punchInAt?.toISOString() ?? '',
        lastSession?.punchOutAt?.toISOString() ?? '',
        record.totalWorkHours,
      ].map(escapeCsv).join(',');
    });

    return [headers.map(escapeCsv).join(','), ...rows].join('\n');
  }
}
