
import {
  Injectable,
  BadRequestException,
  ForbiddenException,
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

  async getAttendanceReport(filters: AttendanceReportFilters, actorUserId?: string) {
    if (!actorUserId) throw new ForbiddenException('Authentication required');
    const actor = await this.prisma.user.findUnique({
      where: { id: actorUserId }, select: { role: true, organizationId: true, status: true },
    });
    if (!actor || actor.status !== 'ACTIVE' || !['ADMIN', 'SUPER_ADMIN'].includes(actor.role)) {
      throw new ForbiddenException('Not authorized to export attendance');
    }
    if (actor.role === 'ADMIN' && !actor.organizationId) throw new ForbiddenException('Admin is not assigned to an organization');

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
      ...(employeeId || departmentId || actor.role === 'ADMIN'
        ? {
            employeeProfile: {
              ...(actor.role === 'ADMIN' ? { user: { organizationId: actor.organizationId } } : {}),
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
            shiftAssignments: { orderBy: { sequence: 'asc' },
              select: { sequence: true, shift: { select: { name: true } } } },
          },
        },
        sessions: {
          orderBy: { punchInAt: 'asc' },
          select: {
            punchInAt: true,
            punchOutAt: true,
            shiftOrder: true,
            shiftName: true,
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
        shift: record.sessions.some(session => !!session.shiftName)
          ? [...new Set(record.sessions.map(session => session.shiftName).filter(Boolean))].join(' / ')
          : record.employeeProfile.shift?.name ?? 'N/A',
        shiftCount: record.assignedShiftCount,
        status: record.status,
        totalWorkMinutes: record.totalWorkMinutes,
        totalWorkHours: Number(
          (record.totalWorkMinutes / 60).toFixed(2),
        ),
        sessions: record.sessions,
      })),
    };
  }

  async exportAttendanceCsv(filters: AttendanceReportFilters, actorUserId?: string) {
    const report = await this.getAttendanceReport(filters, actorUserId);

    // Individual employee export uses only the required number of shift columns;
    // mixed-employee reports show columns up to the largest assignment count.
    const maxShiftCount = Math.max(1, ...report.records.map(record =>
      Math.max(record.shiftCount, ...record.sessions.map(session => session.shiftOrder ?? 1))));
    const shiftHeaders = maxShiftCount === 1
      ? ['Punch In', 'Punch Out']
      : Array.from({ length: maxShiftCount }, (_, index) =>
          [`Shift ${index + 1} Punch In`, `Shift ${index + 1} Punch Out`]).flat();
    const headers = ['Date', 'Employee Code', 'Employee Name', 'Department',
      'Shift', 'Status', ...shiftHeaders, 'Working Hours'];

    const escapeCsv = (value: unknown): string => {
      let text = value == null ? '' : String(value);

      // Protect spreadsheet users from formula injection.
      if (/^[=+\-@\t\r]/.test(text)) {
        text = `'${text}`;
      }

      return `"${text.replace(/"/g, '""')}"`;
    };

    const formatIndiaTime = (value: Date | null | undefined) => value
      ? new Date(value).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata',
          hour: '2-digit', minute: '2-digit', hour12: true })
      : '';
    const rows = report.records.map(record => {
      const shiftCells: string[] = [];
      for (let sequence = 1; sequence <= maxShiftCount; sequence++) {
        const session = record.sessions.find(item => (item.shiftOrder ?? 1) === sequence);
        shiftCells.push(formatIndiaTime(session?.punchInAt));
        shiftCells.push(formatIndiaTime(session?.punchOutAt));
      }
      return [
        new Date(record.workDate).toISOString().slice(0, 10),
        record.employeeCode,
        record.employeeName,
        record.department,
        record.shift,
        record.status,
        ...shiftCells,
        record.totalWorkHours,
      ].map(escapeCsv).join(',');
    });

    return [headers.map(escapeCsv).join(','), ...rows].join('\n');
  }
}
