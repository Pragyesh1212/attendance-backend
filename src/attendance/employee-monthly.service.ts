import {
  BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AttendanceStatus, EmployeeDayType } from '../generated/prisma/client';

export type DayTypeInput = 'WORKDAY' | 'WEEKEND' | 'HOLIDAY';
export type MonthSessionEdit = {
  shiftOrder: number;
  punchIn: string | null;
  punchOut: string | null;
};
export type MonthDayEdit = {
  dayType: DayTypeInput;
  note?: string | null;
  status?: 'PRESENT' | 'LATE' | 'HALF_DAY' | 'ABSENT' | 'ON_LEAVE';
  sessions?: MonthSessionEdit[];
};

const DATE_PATTERN = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const MONTH_PATTERN = /^(20\d\d)-(0[1-9]|1[0-2])$/;
const CLOCK_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;
const dateInIndia = (value: Date) => new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit',
}).format(value);
const dayDate = (day: string) => new Date(`${day}T00:00:00.000Z`);
const asDayKey = (d: Date) => d.toISOString().slice(0, 10);
const fmtDayTime = (date: Date | null | undefined) => date
  ? new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: false }).format(date)
  : '';

@Injectable()
export class EmployeeMonthlyService {
  constructor(private readonly prisma: PrismaService) {}

  private ensureMonth(month: string) {
    if (!MONTH_PATTERN.test(month)) throw new BadRequestException('Month must be YYYY-MM');
    const [year, mon] = month.split('-').map(Number);
    const dayCount = new Date(Date.UTC(year, mon, 0)).getUTCDate();
    return { year, mon, dayCount, start: dayDate(`${month}-01`),
      end: new Date(Date.UTC(year, mon, 1)) };
  }

  private ensureDay(day: string) {
    if (!DATE_PATTERN.test(day) || asDayKey(dayDate(day)) !== day) {
      throw new BadRequestException('Invalid work date (YYYY-MM-DD)');
    }
  }

  private async employeeForActor(employeeUserId: string, actorId: string, canEdit = false) {
    const actor = await this.prisma.user.findUnique({
      where: { id: actorId }, select: { role: true, status: true, organizationId: true },
    });
    if (!actor || actor.status !== 'ACTIVE' || (canEdit ? actor.role !== 'ADMIN' : !['ADMIN', 'SUPER_ADMIN'].includes(actor.role))) {
      throw new ForbiddenException('Not authorized to manage this employee');
    }
    if (actor.role === 'ADMIN' && !actor.organizationId) {
      throw new ForbiddenException('Admin has no assigned organization');
    }
    const employee = await this.prisma.user.findFirst({
      where: { id: employeeUserId, role: 'EMPLOYEE',
        ...(actor.role === 'ADMIN' ? { organizationId: actor.organizationId } : {}) },
      select: {
        id: true, email: true, status: true,
        employeeProfile: { select: {
          id: true, employeeCode: true, firstName: true, lastName: true,
          avatar: { select: { employeeProfileId: true } },
          designation: true, phone: true, avatarUrl: true,
          department: { select: { name: true } },
          workLocation: { select: { name: true, type: true } },
          shift: { select: { id: true, name: true, startTime: true, endTime: true } },
          shiftAssignments: { orderBy: { sequence: 'asc' }, select: {
            sequence: true, shift: { select: { id: true, name: true, startTime: true, endTime: true } },
          } },
        } },
      },
    });
    if (!employee?.employeeProfile) throw new NotFoundException('Employee not found in your organization');
    return employee;
  }

  async getMonth(employeeUserId: string, month: string, actorId: string) {
    const period = this.ensureMonth(month);
    const employee = await this.employeeForActor(employeeUserId, actorId);
    const profile = employee.employeeProfile!;
    const [records, overrides, latestDevice] = await Promise.all([
      this.prisma.attendanceRecord.findMany({
        where: { employeeProfileId: profile.id, workDate: { gte: period.start, lt: period.end } },
        include: { sessions: { orderBy: { shiftOrder: 'asc' }, select: {
          id: true, shiftOrder: true, shiftName: true, shiftStartTime: true, shiftEndTime: true,
          punchInAt: true, punchOutAt: true, approvalStatus: true,
        } } },
      }),
      this.prisma.employeeDayOverride.findMany({
        where: { employeeProfileId: profile.id, workDate: { gte: period.start, lt: period.end } },
      }),
      this.prisma.employeeDevice.findFirst({
        where: { userId: employeeUserId, status: 'APPROVED' },
        orderBy: { approvedAt: 'desc' },
        select: { status: true, label: true, operatingSystem: true, lastSeenAt: true },
      }),
    ]);
    const recordMap = new Map(records.map(r => [asDayKey(r.workDate), r]));
    const overrideMap = new Map(overrides.map(r => [asDayKey(r.workDate), r]));
    const assignedShifts = profile.shiftAssignments.length
      ? profile.shiftAssignments.map(a => ({ order: a.sequence, ...a.shift }))
      : profile.shift ? [{ order: 1, ...profile.shift }] : [];
    const maxShift = Math.max(1, assignedShifts.length, ...records.map(record =>
      Math.max(record.assignedShiftCount, ...record.sessions.map(s => s.shiftOrder || 1))));
    const today = dateInIndia(new Date());
    const days = Array.from({ length: period.dayCount }, (_, i) => {
      const date = `${month}-${String(i + 1).padStart(2, '0')}`;
      const record = recordMap.get(date);
      const override = overrideMap.get(date);
      const dayType: DayTypeInput = override?.dayType ?? 'WORKDAY';
      const status = override ? override.dayType : record?.status ?? (date > today ? 'UPCOMING' : 'NO_RECORD');
      // Report completed, approved session minutes only. Timestamp subtraction also
      // handles overnight shifts (e.g. 18:41 to 06:39 the following morning).
      const completedSessions = (record?.sessions ?? []).filter(s =>
        s.punchOutAt && ['NOT_REQUIRED', 'APPROVED'].includes(s.approvalStatus));
      const workMinutes = completedSessions.length
        ? completedSessions.reduce((sum, session) => sum + Math.max(0,
            Math.floor((session.punchOutAt!.getTime() - session.punchInAt.getTime()) / 60_000)), 0)
        : null;
      const workingHours = workMinutes === null ? '—' :
        `${Math.floor(workMinutes / 60)}h ${workMinutes % 60}m`;
      return {
        date, weekday: new Date(`${date}T00:00:00Z`).toLocaleDateString('en-GB', { timeZone: 'UTC', weekday: 'short' }),
        dayType, note: override?.note ?? record?.notes ?? '', status,
        workMinutes, workingHours,
        attendanceRecordId: record?.id ?? null,
        sessions: (record?.sessions ?? []).map(s => ({
          id: s.id, shiftOrder: s.shiftOrder ?? 1, shiftName: s.shiftName,
          punchIn: fmtDayTime(s.punchInAt), punchOut: fmtDayTime(s.punchOutAt),
          approvalStatus: s.approvalStatus,
        })),
      };
    });
    const summary = {
      present: days.filter(d => d.status === 'PRESENT').length,
      late: days.filter(d => d.status === 'LATE').length,
      absent: days.filter(d => d.status === 'ABSENT').length,
      weekend: days.filter(d => d.status === 'WEEKEND').length,
      holiday: days.filter(d => d.status === 'HOLIDAY').length,
    };
    return {
      month, employee: { userId: employee.id, email: employee.email, status: employee.status,
        employeeProfileId: profile.id, name: `${profile.firstName} ${profile.lastName}`.trim(),
        employeeCode: profile.employeeCode, department: profile.department?.name ?? null,
        designation: profile.designation, phone: profile.phone, workLocation: profile.workLocation?.name ?? null,
        avatarUrl: profile.avatarUrl, hasAvatar: !!profile.avatar || !!profile.avatarUrl, shifts: assignedShifts,
      },
      device: { status: latestDevice?.status ?? 'NOT_REGISTERED',
        name: latestDevice?.label ?? null, os: latestDevice?.operatingSystem ?? null,
        lastSeenAt: latestDevice?.lastSeenAt ?? null },
      maxShift, summary, days,
    };
  }

  private toIstTimestamp(date: string, clock: string): Date {
    if (!CLOCK_PATTERN.test(clock)) throw new BadRequestException('Punch times must use HH:mm (24-hour)');
    return new Date(`${date}T${clock}:00+05:30`);
  }

  async editDay(employeeUserId: string, date: string, input: MonthDayEdit, actorId: string) {
    this.ensureDay(date);
    const employee = await this.employeeForActor(employeeUserId, actorId, true);
    const profileId = employee.employeeProfile!.id;
    const today = dateInIndia(new Date());
    if (!input || !['WORKDAY', 'WEEKEND', 'HOLIDAY'].includes(input.dayType)) {
      throw new BadRequestException('Choose WORKDAY, WEEKEND, or HOLIDAY');
    }
    if (input.note != null && (typeof input.note !== 'string' || input.note.length > 500)) {
      throw new BadRequestException('Remarks cannot exceed 500 characters');
    }
    if (input.sessions && !Array.isArray(input.sessions)) throw new BadRequestException('Invalid sessions');
    if (input.sessions?.length && date > today) throw new BadRequestException('Future punch times cannot be recorded');
    if (input.sessions?.length && input.dayType !== 'WORKDAY') {
      throw new BadRequestException('To change attendance times, mark the date as Workday first');
    }
    if (input.status && date > today) throw new BadRequestException('Future attendance status cannot be set');
    if (input.status && !Object.values(AttendanceStatus).includes(input.status as AttendanceStatus)) {
      throw new BadRequestException('Invalid attendance status');
    }
    if (input.sessions && input.sessions.length > 24) throw new BadRequestException('Too many shifts');
    const profile = employee.employeeProfile!;
    const validOrders = profile.shiftAssignments.length
      ? new Map(profile.shiftAssignments.map(a => [a.sequence, a.shift]))
      : new Map(profile.shift ? [[1, profile.shift]] : []);
    const distinct = new Set<number>();
    const edits = (input.sessions ?? []).map(s => {
      if (!s || typeof s !== 'object') throw new BadRequestException('Invalid session');
      if (!Number.isInteger(s.shiftOrder) || s.shiftOrder < 1 || s.shiftOrder > 24 || distinct.has(s.shiftOrder)) {
        throw new BadRequestException('Invalid or duplicate shift order');
      }
      distinct.add(s.shiftOrder);
      if (!s.punchIn && !s.punchOut) return { ...s, start: null, end: null };
      if (!s.punchIn) throw new BadRequestException('Punch Out requires Punch In');
      const start = this.toIstTimestamp(date, s.punchIn);
      let end = s.punchOut ? this.toIstTimestamp(date, s.punchOut) : null;
      // Overnight shifts are recorded against the date the shift began.
      const slot = validOrders.get(s.shiftOrder);
      if (end && end <= start && slot && slot.endTime <= slot.startTime) {
        end = new Date(end.getTime() + 86_400_000);
      }
      if (!end && date < today) throw new BadRequestException('Historical entries need Punch In and Punch Out');
      if (end && (end <= start || end.getTime() - start.getTime() > 24 * 3600_000)) {
        throw new BadRequestException('Punch Out must follow Punch In within 24 hours');
      }
      if (start > new Date() || (end && end > new Date())) {
        throw new BadRequestException('Punch times cannot be in the future');
      }
      return { ...s, start, end };
    });
    for (const entry of edits) if (!validOrders.has(entry.shiftOrder)) {
      // Historical session editing must still be possible after shift assignments change.
      const exists = await this.prisma.attendanceSession.findFirst({
        where: { attendanceRecord: { employeeProfileId: profileId, workDate: dayDate(date) }, shiftOrder: entry.shiftOrder },
        select: { id: true },
      });
      if (!exists) throw new BadRequestException(`Shift ${entry.shiftOrder} is not assigned to this employee`);
    }
    const result = await this.prisma.$transaction(async tx => {
      const workDate = dayDate(date);
      const before = await tx.attendanceRecord.findUnique({
        where: { employeeProfileId_workDate: { employeeProfileId: profileId, workDate } }, include: { sessions: true },
      });
      if (input.dayType !== 'WORKDAY' && before?.sessions.some(s => !s.punchOutAt && s.approvalStatus !== 'REJECTED')) {
        throw new ConflictException('Finish or resolve the active attendance session before marking this date off');
      }
      if (input.dayType === 'WORKDAY' && !before && !!input.note?.trim() && !input.status && !edits.some(e => e.start)) {
        throw new BadRequestException('Select an attendance status or enter punch times before adding workday remarks');
      }
      if (input.dayType === 'WORKDAY') {
        await tx.employeeDayOverride.deleteMany({ where: { employeeProfileId: profileId, workDate } });
      } else {
        await tx.employeeDayOverride.upsert({
          where: { employeeProfileId_workDate: { employeeProfileId: profileId, workDate } },
          create: { employeeProfileId: profileId, workDate,
            dayType: input.dayType as EmployeeDayType, note: input.note?.trim() || null, updatedByUserId: actorId },
          update: { dayType: input.dayType as EmployeeDayType, note: input.note?.trim() || null, updatedByUserId: actorId },
        });
      }
      if (edits.some(e => e.start) || input.status || (before && input.dayType === 'WORKDAY' && input.note !== undefined)) {
        const record = await tx.attendanceRecord.upsert({
          where: { employeeProfileId_workDate: { employeeProfileId: profileId, workDate } },
          create: { employeeProfileId: profileId, workDate, assignedShiftCount: Math.max(1, validOrders.size),
            status: input.status as AttendanceStatus ?? 'PRESENT', notes: input.note?.trim() || null },
          update: { ...(input.status ? { status: input.status as AttendanceStatus } : {}),
            ...(input.note !== undefined ? { notes: input.note?.trim() || null } : {}) },
        });
        for (const edit of edits) {
          const prior = await tx.attendanceSession.findFirst({
            where: { attendanceRecordId: record.id, shiftOrder: edit.shiftOrder },
          });
          if (edit.start) {
            const slot = validOrders.get(edit.shiftOrder);
            if (prior) {
              if (prior.approvalStatus === 'PENDING') {
                throw new ConflictException('Review pending late approval before editing this shift');
              }
              if (!prior.punchOutAt && date === today) {
                throw new ConflictException('Complete the active Punch Out before editing this shift');
              }
              const pendingCorrections = await tx.attendanceCorrectionRequest.count({
                where: { attendanceSessionId: prior.id, status: 'PENDING' },
              });
              if (pendingCorrections) throw new ConflictException('Resolve the pending attendance correction first');
              await tx.attendanceSession.update({ where: { id: prior.id }, data: {
                punchInAt: edit.start, punchOutAt: edit.end,
                // Manual correction is authorized by Admin; preserve existing approval audit history.
              } });
            } else {
              await tx.attendanceSession.create({ data: {
                attendanceRecordId: record.id, shiftOrder: edit.shiftOrder,
                shiftId: slot?.id, shiftName: slot?.name ?? `Shift ${edit.shiftOrder}`,
                shiftStartTime: slot?.startTime, shiftEndTime: slot?.endTime,
                punchInAt: edit.start, punchOutAt: edit.end,
                approvalStatus: 'NOT_REQUIRED',
              } });
            }
          }
        }
        const sessions = await tx.attendanceSession.findMany({
          where: { attendanceRecordId: record.id, punchOutAt: { not: null },
            approvalStatus: { in: ['NOT_REQUIRED', 'APPROVED'] } },
        });
        const minutes = sessions.reduce((sum, s) => sum + Math.max(0,
          Math.floor((s.punchOutAt!.getTime() - s.punchInAt.getTime()) / 60000)), 0);
        await tx.attendanceRecord.update({ where: { id: record.id }, data: { totalWorkMinutes: minutes } });
      }
      await tx.auditLog.create({ data: {
        actorUserId: actorId, action: 'EMPLOYEE_ATTENDANCE_MANUAL_EDIT',
        entityType: 'EMPLOYEE_PROFILE', entityId: profileId,
        description: `Admin edited attendance for ${date}`,
        metadata: { workDate: date, dayType: input.dayType, requested: JSON.parse(JSON.stringify(input)),
          previous: before ? { status: before.status, notes: before.notes,
            sessions: before.sessions.map(s => ({ id: s.id, shiftOrder: s.shiftOrder,
              punchInAt: s.punchInAt.toISOString(), punchOutAt: s.punchOutAt?.toISOString() })) } : null },
      } });
      return { saved: true, date };
    });
    return result;
  }

  // One transaction for all selected dates: no partially applied weekend/holiday batches.
  async bulkSetDayType(employeeUserId: string,
    input: { dates: string[]; dayType: DayTypeInput }, actorId: string) {
    const employee = await this.employeeForActor(employeeUserId, actorId, true);
    if (!input || !Array.isArray(input.dates) || !['WORKDAY', 'WEEKEND', 'HOLIDAY'].includes(input.dayType)) {
      throw new BadRequestException('Provide dates and a valid day type');
    }
    const dates = [...new Set(input.dates)];
    if (!dates.length || dates.length > 31 || dates.length !== input.dates.length) {
      throw new BadRequestException('Select between 1 and 31 distinct dates');
    }
    for (const date of dates) {
      if (typeof date !== 'string') throw new BadRequestException('Invalid date');
      this.ensureDay(date);
    }
    if (!dates.every(date => date.slice(0, 7) === dates[0].slice(0, 7))) {
      throw new BadRequestException('Bulk changes must be within one calendar month');
    }
    const employeeProfileId = employee.employeeProfile!.id;
    const workDates = dates.map(dayDate);
    return this.prisma.$transaction(async tx => {
      if (input.dayType !== 'WORKDAY') {
        const activeSession = await tx.attendanceSession.findFirst({
          where: {
            attendanceRecord: { is: { employeeProfileId, workDate: { in: workDates } } },
            punchOutAt: null, approvalStatus: { not: 'REJECTED' },
          },
          select: { id: true },
        });
        if (activeSession) {
          throw new ConflictException('At least one selected date has an active attendance session. Complete or resolve it before marking those dates off. No changes were saved.');
        }
      }
      const previous = await tx.employeeDayOverride.findMany({
        where: { employeeProfileId, workDate: { in: workDates } },
        select: { workDate: true, dayType: true, note: true },
      });
      if (input.dayType === 'WORKDAY') {
        await tx.employeeDayOverride.deleteMany({
          where: { employeeProfileId, workDate: { in: workDates } },
        });
      } else {
        for (const workDate of workDates) {
          await tx.employeeDayOverride.upsert({
            where: { employeeProfileId_workDate: { employeeProfileId, workDate } },
            create: { employeeProfileId, workDate, dayType: input.dayType as EmployeeDayType,
              updatedByUserId: actorId },
            update: { dayType: input.dayType as EmployeeDayType, updatedByUserId: actorId },
          });
        }
      }
      await tx.auditLog.create({ data: {
        actorUserId: actorId, action: 'EMPLOYEE_ATTENDANCE_BULK_DAY_TYPE_UPDATE',
        entityType: 'EMPLOYEE_PROFILE', entityId: employeeProfileId,
        description: `Admin marked ${dates.length} date(s) as ${input.dayType}`,
        metadata: {
          dayType: input.dayType, dates,
          previous: previous.map(row => ({ date: asDayKey(row.workDate), dayType: row.dayType, note: row.note })),
        },
      } });
      return { saved: true, affectedCount: dates.length, dates, dayType: input.dayType };
    }, { timeout: 20_000 });
  }

  // EMPLOYEE access: only their own calendar overrides. Leaves current attendance API intact.
  async myDayOverrides(userId: string, month: string) {
    const { start, end } = this.ensureMonth(month);
    const profile = await this.prisma.employeeProfile.findUnique({ where: { userId }, select: { id: true } });
    if (!profile) throw new NotFoundException('Employee profile not found');
    const days = await this.prisma.employeeDayOverride.findMany({
      where: { employeeProfileId: profile.id, workDate: { gte: start, lt: end } },
      select: { workDate: true, dayType: true, note: true },
    });
    return days.map(d => ({ date: asDayKey(d.workDate), dayType: d.dayType, note: d.note }));
  }

  async isDayOff(employeeProfileId: string, workDate: Date) {
    return this.prisma.employeeDayOverride.findUnique({
      where: { employeeProfileId_workDate: { employeeProfileId, workDate } }, select: { dayType: true },
    });
  }
}
