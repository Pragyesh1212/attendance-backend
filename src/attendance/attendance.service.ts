
import {
    Injectable,
    NotFoundException,
    ForbiddenException,
    ConflictException,
    InternalServerErrorException,
    Logger,
    OnModuleInit,
    OnModuleDestroy,
} from '@nestjs/common';

import { isIP } from 'node:net';
import { PrismaService } from '../prisma/prisma.service';
import {
    UserStatus,
    ShiftStatus,
    AttendanceStatus,
} from '../generated/prisma/client';

import { WorkLocationsService } from '../work-locations/work-locations.service';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import { PunchInDto } from './dto/punch-in.dto';
import { PunchOutDto } from './dto/punch-out.dto';
import { GetAttendanceDto } from './dto/get-attendance.dto';
import { ReviewAttendanceDto } from './dto/review-attendance.dto';
import { CreateAttendanceCorrectionDto } from './dto/create-attendance-correction.dto';
import { ReviewAttendanceCorrectionDto } from './dto/review-attendance-correction.dto';

@Injectable()
export class AttendanceService implements OnModuleInit, OnModuleDestroy {
    constructor(
        private readonly prisma: PrismaService,
        private readonly workLocationsService: WorkLocationsService,
        private readonly auditLogsService: AuditLogsService,
    ) { }

    // Automatic absence is intentionally opt-in: there is no workday/holiday
    // calendar in the current Prisma schema, so enabling it without explicit
    // dates would create false absences on weekends and holidays.
    private readonly absenceLogger = new Logger('AttendanceAutoAbsent');
    private absenceTimer: ReturnType<typeof setInterval> | null = null;
    private absenceRunning = false;
    private eligibleWorkdays: Set<number> | null = null;
    private holidays = new Set<string>();

    onModuleInit(): void {
        if (process.env.ATTENDANCE_AUTO_ABSENT_ENABLED !== 'true') {
            return;
        }

        const rawWorkdays = process.env.ATTENDANCE_WORKDAYS?.trim() ?? '';
        const values = rawWorkdays.split(',').map((day) => day.trim());
        if (!rawWorkdays || values.some((day) => !/^[1-7]$/.test(day))) {
            this.absenceLogger.error(
                'Auto-ABSENT is disabled: ATTENDANCE_WORKDAYS must contain ISO weekdays 1-7 (example: 1,2,3,4,5).',
            );
            return;
        }

        const holidayValues = (process.env.ATTENDANCE_HOLIDAYS ?? '')
            .split(',').map((day) => day.trim()).filter(Boolean);
        if (holidayValues.some((day) => !/^\d{4}-\d{2}-\d{2}$/.test(day) ||
            Number.isNaN(Date.parse(`${day}T00:00:00.000Z`)))) {
            this.absenceLogger.error(
                'Auto-ABSENT is disabled: ATTENDANCE_HOLIDAYS must be comma-separated YYYY-MM-DD dates.',
            );
            return;
        }

        this.eligibleWorkdays = new Set(values.map(Number));
        this.holidays = new Set(holidayValues);

        this.absenceLogger.log('Automatic absence marking enabled for configured workdays.');
        void this.markMissingPunchInsAbsent();
        this.absenceTimer = setInterval(() => {
            void this.markMissingPunchInsAbsent();
        }, 5 * 60 * 1000);
        // The scheduler should not keep a CLI/test process alive by itself.
        this.absenceTimer.unref?.();
    }

    onModuleDestroy(): void {
        if (this.absenceTimer) {
            clearInterval(this.absenceTimer);
            this.absenceTimer = null;
        }
    }

    private getIndiaDateKey(date: Date): string {
        const parts = new Intl.DateTimeFormat('en-GB', {
            timeZone: 'Asia/Kolkata',
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
        }).formatToParts(date);
        const map = Object.fromEntries(parts.map((part) => [part.type, part.value]));
        return `${map.year}-${map.month}-${map.day}`;
    }

    private getAbsenceCutoffMinutes(shift: {
        startTime: string;
        endTime: string;
        approvalRequiredAfterMinutes: number | null;
    }): number | null {
        const timeToMinutes = (value: string): number | null => {
            if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value)) return null;
            const [hours, minutes] = value.split(':').map(Number);
            return hours * 60 + minutes;
        };
        const start = timeToMinutes(shift.startTime);
        const end = timeToMinutes(shift.endTime);
        // Current punch-in policy does not reliably support overnight shifts.
        if (start === null || end === null || end <= start) return null;
        const offset = shift.approvalRequiredAfterMinutes;
        if (offset === null) return end;
        if (!Number.isInteger(offset) || offset < 0) return null;
        return Math.min(end, start + offset);
    }

    // Called on startup and every five minutes. Optional one-day lookback
    // can be enabled explicitly. Existing attendance (including ON_LEAVE
    // and pending approval requests) is never overwritten.
    private async markMissingPunchInsAbsent(now: Date = new Date()): Promise<void> {
        const eligibleWorkdays = this.eligibleWorkdays;
        if (this.absenceRunning || !eligibleWorkdays) return;
        this.absenceRunning = true;
        try {
            const today = this.getIndiaDateKey(now);
            const yesterday = new Date(Date.parse(`${today}T00:00:00.000Z`) - 86_400_000)
                .toISOString().slice(0, 10);
            // Disabled by default to avoid retrospective changes following a
            // shift reassignment. Enable only after reviewing historical policy.
            const dateKeys = process.env.ATTENDANCE_ABSENCE_BACKFILL_YESTERDAY === 'true'
                ? [yesterday, today]
                : [today];

            const employees = await this.prisma.employeeProfile.findMany({
                where: {
                    user: { is: { role: 'EMPLOYEE', status: UserStatus.ACTIVE } },
                    shift: { is: { status: ShiftStatus.ACTIVE } },
                },
                select: {
                    id: true,
                    createdAt: true,
                    joiningDate: true,
                    user: { select: { createdAt: true, organizationId: true } },
                    shift: {
                        select: {
                            startTime: true,
                            endTime: true,
                            approvalRequiredAfterMinutes: true,
                            organizationId: true,
                        },
                    },
                },
            });

            for (const dateKey of dateKeys) {
                const workDate = new Date(`${dateKey}T00:00:00.000Z`);
                const isoWeekday = workDate.getUTCDay() || 7;
                if (!eligibleWorkdays.has(isoWeekday) || this.holidays.has(dateKey)) {
                    continue;
                }

                const candidates: { employeeProfileId: string; workDate: Date; status: AttendanceStatus }[] = [];
                for (const employee of employees) {
                    if (!employee.shift || !employee.user.organizationId) continue;
                    if (employee.shift.organizationId &&
                        employee.shift.organizationId !== employee.user.organizationId) continue;

                    const cutoffMinutes = this.getAbsenceCutoffMinutes(employee.shift);
                    if (cutoffMinutes === null) continue;

                    const cutoffAt = Date.parse(`${dateKey}T00:00:00+05:30`) + cutoffMinutes * 60_000;
                    if (now.getTime() < cutoffAt ||
                        employee.user.createdAt.getTime() > cutoffAt ||
                        employee.createdAt.getTime() > cutoffAt) continue;

                    if (employee.joiningDate && this.getIndiaDateKey(employee.joiningDate) > dateKey) {
                        continue;
                    }
                    candidates.push({
                        employeeProfileId: employee.id,
                        workDate,
                        status: AttendanceStatus.ABSENT,
                    });
                }

                if (!candidates.length) continue;
                // The existing @@unique([employeeProfileId, workDate]) makes this
                // idempotent across restarts and multiple app replicas.
                const result = await this.prisma.attendanceRecord.createMany({
                    data: candidates,
                    skipDuplicates: true,
                });
                if (result.count > 0) {
                    this.absenceLogger.log(
                        `Marked ${result.count} missing Punch In(s) ABSENT for ${dateKey}.`,
                    );
                }
            }
        } catch (error) {
            this.absenceLogger.error(
                'Auto-ABSENT check failed; it will be retried on the next run.',
                error instanceof Error ? error.stack : String(error),
            );
        } finally {
            this.absenceRunning = false;
        }
    }

    /**
     * For ADMIN/SUPER_ADMIN read & review routes. The trusted user ID comes
     * from JWT authentication, but organization membership is read fresh from DB.
     * null means SUPER_ADMIN's company-wide access only.
     */
    private async getAdminOrganizationId(actorUserId: string): Promise<string | null> {
        const user = await this.prisma.user.findUnique({
            where: { id: actorUserId },
            select: { role: true, status: true, organizationId: true },
        });
        if (!user || user.status !== 'ACTIVE') {
            throw new ForbiddenException('Account is not authorized');
        }
        if (user.role === 'SUPER_ADMIN') return null;
        if (user.role !== 'ADMIN' || !user.organizationId) {
            throw new ForbiddenException('Admin account is not assigned to an organization');
        }
        return user.organizationId;
    }

    // Verify that the request comes from an authorized office public IP.
    // private validateOfficeNetwork(clientIp: string): void {
    //     const allowedIps = (process.env.OFFICE_PUBLIC_IPS ?? '')
    //         .split(',')
    //         .map((ip) => ip.trim())
    //         .filter(Boolean);
    //     console.log('Allowed office IPs:', allowedIps);
    //     console.log('Client IP:', clientIp);
    //     console.log(process.env.OFFICE_PUBLIC_IPS);
    //     if (allowedIps.length === 0) {
    //         throw new InternalServerErrorException(
    //             'Office network configuration is missing',
    //         );
    //     }

    //     const normalizeIp = (ip: string) =>
    //         ip.trim().replace(/^::ffff:/i, '');

    //     const normalizedClientIp = normalizeIp(clientIp);
    //     const isAuthorized = allowedIps.some(
    //         (ip) => normalizeIp(ip) === normalizedClientIp,
    //     );

    //     if (!normalizedClientIp || !isAuthorized) {
    //         throw new ForbiddenException(
    //             'You must connect to the authorized office network to mark attendance.',
    //         );
    //     }
    // }

    // Calculate distance between two GPS coordinates using Haversine formula
    private calculateDistance(
        latitude1: number,
        longitude1: number,
        latitude2: number,
        longitude2: number,
    ): number {
        const earthRadius = 6371000;

        const toRadians = (degrees: number) =>
            (degrees * Math.PI) / 180;

        const latDifference = toRadians(latitude2 - latitude1);
        const lonDifference = toRadians(longitude2 - longitude1);

        const a =
            Math.sin(latDifference / 2) ** 2 +
            Math.cos(toRadians(latitude1)) *
            Math.cos(toRadians(latitude2)) *
            Math.sin(lonDifference / 2) ** 2;

        const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

        return earthRadius * c;
    }

    // Validate employee's GPS against their currently assigned location
    private async validateEmployeeLocation(
        employeeProfileId: string,
        latitude: number,
        longitude: number,
        clientIp?: string,
    ) {
        const effectiveLocation =
            await this.workLocationsService.getEffectiveLocation(
                employeeProfileId,
            );

        const location = effectiveLocation.location;

        // Enforce the assigned location's IP allowlist when configured.
        // Never use a client-supplied body field as the source of clientIp.
        const allowedIps: string[] = location.allowedPublicIps ?? [];
        if (location.type === 'OFFICE' && allowedIps.length === 0) {
            throw new ForbiddenException('Office network IP is not configured for your assigned location. Contact your administrator.');
        }
        if (allowedIps.length) {
            const normalize = (ip: string) => ip.trim().replace(/^::ffff:/i, '');
            const actualIp = normalize(clientIp ?? '');
            if (!isIP(actualIp) || !allowedIps.some(ip => normalize(ip) === actualIp)) {
                throw new ForbiddenException('Connect to the authorized network for your assigned work location.');
            }
        }

        const distance = this.calculateDistance(
            latitude,
            longitude,
            location.latitude,
            location.longitude,
        );

        if (distance > location.radiusMeters) {
            throw new ForbiddenException(
                `You are outside your assigned work location. Allowed radius: ${location.radiusMeters} meters. Your distance: ${Math.round(distance)} meters.`,
            );
        }

        return {
            location,
            assignmentType: effectiveLocation.assignmentType,
            distanceMeters: Math.round(distance),
        };
    }
    // EMPLOYEE: GET MY ATTENDANCE HISTORY
    async getMyAttendance(userId: string, query: GetAttendanceDto) {
        const employee = await this.prisma.employeeProfile.findUnique({
            where: { userId },
            select: { id: true },
        });

        if (!employee) {
            throw new NotFoundException('Employee profile not found');
        }

        return this.getAttendanceRecords(employee.id, query);
    }

    // ADMIN / SUPER ADMIN: GET ALL ATTENDANCE
    async getAllAttendance(query: GetAttendanceDto, actorUserId: string) {
        const organizationId = await this.getAdminOrganizationId(actorUserId);
        return this.getAttendanceRecords(
            query.employeeProfileId,
            query,
            organizationId,
        );
    }

    // COMMON ATTENDANCE HISTORY QUERY
    private async getAttendanceRecords(
        employeeProfileId: string | undefined,
        query: GetAttendanceDto,
        organizationId?: string | null,
    ) {
        const {
            page = 1,
            limit = 10,
            startDate,
            endDate,
            status,
        } = query;

        const skip = (page - 1) * limit;

        const where = {
            ...(employeeProfileId ? { employeeProfileId } : {}),
            ...(organizationId ? { employeeProfile: { user: { organizationId } } } : {}),
            ...(status ? { status } : {}),
            ...(startDate || endDate
                ? {
                    workDate: {
                        ...(startDate
                            ? { gte: new Date(`${startDate}T00:00:00.000Z`) }
                            : {}),
                        ...(endDate
                            ? {
                                lt: new Date(
                                    new Date(`${endDate}T00:00:00.000Z`).getTime() + 86400000
                                )
                            }
                            : {}),
                    },
                }
                : {}),
        };

        const [records, total] = await this.prisma.$transaction([
            this.prisma.attendanceRecord.findMany({
                where,
                include: {
                    employeeProfile: {
                        include: {
                            user: {
                                select: {
                                    id: true,
                                    email: true,
                                },
                            },
                            department: true,
                            shift: true,
                        },
                    },
                    sessions: {
                        orderBy: {
                            punchInAt: 'asc',
                        },
                    },
                },
                orderBy: {
                    workDate: 'desc',
                },
                skip,
                take: limit,
            }),

            this.prisma.attendanceRecord.count({ where }),
        ]);

        return {
            data: records,
            pagination: {
                total,
                page,
                limit,
                totalPages: Math.ceil(total / limit),
            },
        };
    }

    // ADMIN / SUPER ADMIN: GET ATTENDANCE DETAILS
    async getAttendanceById(id: string, actorUserId: string) {
        const organizationId = await this.getAdminOrganizationId(actorUserId);
        const record = await this.prisma.attendanceRecord.findFirst({
            where: { id, ...(organizationId ? { employeeProfile: { user: { organizationId } } } : {}) },
            include: {
                employeeProfile: {
                    include: {
                        user: {
                            select: {
                                id: true,
                                email: true,
                                status: true,
                            },
                        },
                        department: true,
                        shift: true,
                    },
                },
                sessions: {
                    orderBy: {
                        punchInAt: 'asc',
                    },
                },
            },
        });

        if (!record) {
            throw new NotFoundException('Attendance record not found');
        }

        return record;
    }

    // Determine the final punch-in deadline in minutes from midnight (IST).
    // For ordinary same-day shifts, never allow punch-in at/after shift end.
    // An earlier administrator-configured cutoff takes precedence.
    // Overnight shifts retain their prior configured-cutoff behavior and need
    // a separate date-aware schedule policy before extending that behavior.
    private getPunchInDeadlineMinutes(shift: {
        startTime: string;
        endTime: string;
        approvalRequiredAfterMinutes: number | null;
    }): number | null {
        const [startHour, startMinute] = shift.startTime.split(':').map(Number);
        const [endHour, endMinute] = shift.endTime.split(':').map(Number);
        if (![startHour, startMinute, endHour, endMinute].every(Number.isFinite)) {
            throw new InternalServerErrorException('The assigned shift has an invalid time configuration.');
        }
        const start = startHour * 60 + startMinute;
        const end = endHour * 60 + endMinute;
        const offset = shift.approvalRequiredAfterMinutes;
        const adminCutoff = offset == null ? null : start + offset;
        if (end > start) {
            return adminCutoff == null ? end : Math.min(end, adminCutoff);
        }
        return adminCutoff;
    }

    // EMPLOYEE: Punch-in cutoff preflight for the Angular button state.
    // Uses the same two existing Shift columns as punchIn(), avoiding a migration.
    // The server-side punchIn() method ALWAYS enforces the cutoff again.
    async getMyPunchInPolicy(userId: string) {
        const employee = await this.prisma.employeeProfile.findUnique({
            where: { userId },
            include: { shift: true },
        });

        if (!employee) {
            throw new NotFoundException('Employee profile not found');
        }

        const shift = employee.shift;
        if (!shift || shift.status !== ShiftStatus.ACTIVE) {
            return {
                status: 'CLOSED' as const,
                cutoffReached: true,
                opensAt: null,
                cutoffAt: null,
                message: 'No active shift is assigned to you. Please contact your Admin.',
            };
        }

        const deadlineMinutes = this.getPunchInDeadlineMinutes(shift);
        if (deadlineMinutes === null) {
            // Overnight shifts without a configured cutoff must be explicitly
            // supported rather than silently assuming the next-day end time.
            return {
                status: 'CLOSED' as const,
                cutoffReached: true,
                opensAt: null,
                cutoffAt: null,
                message: 'Unable to determine punch-in closing time. Please contact your Admin.',
            };
        }

        const now = new Date();
        const parts = new Intl.DateTimeFormat('en-GB', {
            timeZone: 'Asia/Kolkata',
            year: 'numeric', month: '2-digit', day: '2-digit',
        }).formatToParts(now);
        const v = Object.fromEntries(parts.map(p => [p.type, p.value]));

        // ISO with an explicit IST offset ensures every employee sees the
        // same server deadline independent of the browser's local timezone.
        const midnightIst = Date.parse(`${v.year}-${v.month}-${v.day}T00:00:00+05:30`);
        const [startHour, startMinute] = shift.startTime.split(':').map(Number);
        const startMinutes = startHour * 60 + startMinute;
        const opensAt = new Date(midnightIst + startMinutes * 60000);
        const cutoffAt = new Date(midnightIst + deadlineMinutes * 60000);

        // Both boundaries must be enforced. At 1 AM, a 9 AM shift
        // has not begun even though its cutoff is still in the future.
        const status: 'NOT_STARTED' | 'OPEN' | 'CLOSED' =
            now.getTime() < opensAt.getTime()
                ? 'NOT_STARTED'
                : now.getTime() >= cutoffAt.getTime()
                    ? 'CLOSED'
                    : 'OPEN';

        const startLabel = opensAt.toLocaleTimeString('en-IN', {
            timeZone: 'Asia/Kolkata',
            hour: 'numeric',
            minute: '2-digit',
            hour12: true,
        });

        return {
            status,
            cutoffReached: status === 'CLOSED',
            opensAt: opensAt.toISOString(),
            cutoffAt: cutoffAt.toISOString(),
            message: status === 'NOT_STARTED'
                ? `Your shift starts at ${startLabel}. Punch In will be available at shift start.`
                : status === 'CLOSED'
                    ? 'Punch In is closed for your shift. Please contact your Admin.'
                    : null,
        };
    }

    // PUNCH IN
    async punchIn(userId: string, dto: PunchInDto, clientIp?: string) {
        // this.validateOfficeNetwork(clientIp);
        // 1. Find employee and assigned shift
        const employee = await this.prisma.employeeProfile.findUnique({
            where: { userId },
            include: {
                user: true,
                shift: true,
            },
        });

        if (!employee) {
            throw new NotFoundException('Employee profile not found');
        }

        if (employee.user.status !== UserStatus.ACTIVE) {
            throw new ForbiddenException('Your account is inactive');
        }

        if (!employee.shift || employee.shift.status !== ShiftStatus.ACTIVE) {
            throw new ForbiddenException('No active shift assigned to you');
        }
        const assignedShift = employee.shift;

        // 3. Get current date and time in India
        const now = new Date();

        const parts = new Intl.DateTimeFormat('en-GB', {
            timeZone: 'Asia/Kolkata',
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
            hourCycle: 'h23',
        }).formatToParts(now);

        const values = Object.fromEntries(
            parts.map((part) => [part.type, part.value]),
        );

        const dateString = `${values.year}-${values.month}-${values.day}`;
        const workDate = new Date(`${dateString}T00:00:00.000Z`);

        const currentMinutes =
            Number(values.hour) * 60 + Number(values.minute);

        // 4. Calculate late arrival and approval requirements
        const [shiftHour, shiftMinute] = assignedShift.startTime
            .split(':')
            .map(Number);

        const shiftStartMinutes = shiftHour * 60 + shiftMinute;

        // Reject early punch-in on the server as well as in the Angular UI.
        // Example: for a 09:00 shift, 00:59 is NOT an allowed punch-in time.
        if (currentMinutes < shiftStartMinutes) {
            const startLabel = new Date(
                Date.UTC(2020, 0, 1, shiftHour, shiftMinute),
            ).toLocaleTimeString('en-IN', {
                timeZone: 'UTC',
                hour: 'numeric',
                minute: '2-digit',
                hour12: true,
            });
            throw new ForbiddenException(
                `Your shift starts at ${startLabel}. Punch In will be available at shift start.`,
            );
        }

        const rawMinutesLate = currentMinutes - shiftStartMinutes;

        const minutesLate = Math.max(0, rawMinutesLate);

        // The frontend labels reuse the two existing Shift DB fields:
        // lateReasonAfterMinutes -> Admin approval required after X minutes.
        // approvalRequiredAfterMinutes -> Punch In DISABLED after X minutes.
        // Both count from shift start, not the end of the grace period.
        const gracePeriodMinutes = assignedShift.gracePeriodMinutes ?? 0;
        const adminApprovalAfterMinutes =
            assignedShift.lateReasonAfterMinutes ?? null;

        // The backend is authoritative; the end of a same-day shift is an
        // automatic hard cutoff, even when an Admin left the earlier cutoff blank.
        const deadlineMinutes = this.getPunchInDeadlineMinutes(assignedShift);
        if (deadlineMinutes === null || currentMinutes >= deadlineMinutes) {
            throw new ForbiddenException(
                'Punch In is closed for your shift. Please contact your Admin.',
            );
        }

        const isLate = minutesLate > gracePeriodMinutes;
        const approvalRequired =
            isLate &&
            adminApprovalAfterMinutes !== null &&
            minutesLate >= adminApprovalAfterMinutes;

        // An Admin approval request must include a reason.
        const reasonRequired = approvalRequired;

        const approvalStatus = approvalRequired
            ? 'PENDING'
            : 'NOT_REQUIRED';

        // Continue existing GPS and assigned-network validation only if the
        // shift allows punch-in at the current India-local time.
        const locationValidation = await this.validateEmployeeLocation(
            employee.id,
            dto.latitude,
            dto.longitude,
            clientIp,
        );

        const attendanceStatus = isLate
            ? AttendanceStatus.LATE
            : AttendanceStatus.PRESENT;

        // 5. One attendance session per employee per India workday.
        // The unique employeeProfileId_workDate key ensures one parent record.
        // A row lock serializes concurrent punch-in and punch-out requests.
        const result = await this.prisma.$transaction(async (tx) => {
            let record = await tx.attendanceRecord.upsert({
                where: {
                    employeeProfileId_workDate: {
                        employeeProfileId: employee.id,
                        workDate,
                    },
                },
                create: {
                    employeeProfileId: employee.id,
                    workDate,
                    status: attendanceStatus,
                },
                update: {},
            });

            // Lock today's parent record BEFORE inspecting sessions.
            // This prevents parallel API requests from both creating a session.
            await tx.$queryRaw`
                SELECT "id" FROM "attendance_records"
                WHERE "id" = ${record.id}::uuid
                FOR UPDATE
            `;

            // Any session (open, completed, pending, or rejected) consumes
            // the employee's single punch-in opportunity for today.
            const existingSession = await tx.attendanceSession.findFirst({
                where: { attendanceRecordId: record.id },
                orderBy: { punchInAt: 'desc' },
            });

            if (existingSession?.approvalStatus === 'PENDING') {
                throw new ForbiddenException(
                    'Your late arrival request is awaiting Admin approval. You cannot punch in again today.',
                );
            }

            if (existingSession?.approvalStatus === 'REJECTED') {
                throw new ForbiddenException(
                    'Your late arrival request was rejected. Please contact Admin.',
                );
            }

            if (existingSession?.punchOutAt) {
                throw new ConflictException(
                    'You have already punched in and out today. Attendance is allowed only once per day.',
                );
            }

            if (existingSession) {
                throw new ConflictException(
                    'You have already punched in today. Please punch out when your workday ends.',
                );
            }

            // Keep existing shift late-reason and approval rules intact.
            if (reasonRequired && !dto.lateReason?.trim()) {
                throw new ConflictException(
                    approvalRequired
                        ? `You are ${minutesLate} minutes late and Admin approval is required. Please provide a reason for your late arrival.`
                        : `You are ${minutesLate} minutes late. Please provide a reason for your late arrival.`,
                );
            }

            if (record.status === AttendanceStatus.PRESENT && isLate) {
                record = await tx.attendanceRecord.update({
                    where: { id: record.id },
                    data: { status: AttendanceStatus.LATE },
                });
            }

            // 7. Save punch-in and GPS information
            const session = await tx.attendanceSession.create({
                data: {
                    attendanceRecordId: record.id,
                    punchInAt: now,
                    punchInLatitude: dto.latitude,
                    punchInLongitude: dto.longitude,
                    punchInAccuracy: dto.accuracy,

                    approvalStatus,
                    lateMinutes: minutesLate,
                    lateReason: dto.lateReason?.trim() || null,
                },
            });

            return {
                message: approvalRequired
                    ? 'Late arrival request submitted. You cannot start attendance work until Admin approves it.'
                    : 'Punch-in successful',

                attendanceStatus: record.status,
                approvalStatus: session.approvalStatus,
                lateMinutes: session.lateMinutes,
                isLate,
                lateReasonRequired: reasonRequired,
                reasonRequired,
                approvalRequired,
                canPunchOut: !approvalRequired,
                nextAction: approvalRequired
                    ? 'WAIT_FOR_ADMIN_APPROVAL'
                    : 'CONTINUE_WORK',
                shiftPolicy: {
                    shiftStartTime: assignedShift.startTime,
                    gracePeriodMinutes,
                    // Keep legacy API keys for compatibility, while adding
                    // explicit names that describe their current behavior.
                    lateReasonAfterMinutes: assignedShift.lateReasonAfterMinutes,
                    approvalRequiredAfterMinutes: assignedShift.approvalRequiredAfterMinutes,
                    adminApprovalAfterMinutes,
                    punchInDisabledAfterMinutes: assignedShift.approvalRequiredAfterMinutes ?? null,
                },

                assignedLocation: locationValidation.location.name,
                assignmentType: locationValidation.assignmentType,
                distanceMeters: locationValidation.distanceMeters,

                session,
            };
        });

        await this.auditLogsService.createLog({
            actorUserId: userId,
            action: 'ATTENDANCE_PUNCHED_IN',
            entityType: 'ATTENDANCE_SESSION',
            entityId: result.session.id,
            description: `Employee ${employee.employeeCode} punched in`,
            metadata: {
                attendanceStatus: result.attendanceStatus,
                approvalStatus: result.approvalStatus,
                lateMinutes: result.lateMinutes,
                assignedLocation: locationValidation.location.name,
            },
        });

        return result;
    }

    // PUNCH OUT
    async punchOut(userId: string, dto: PunchOutDto, clientIp?: string) {
        // this.validateOfficeNetwork(clientIp);
        // 1. Find employee
        const employee = await this.prisma.employeeProfile.findUnique({
            where: { userId },
            include: {
                user: true,
            },
        });

        if (!employee) {
            throw new NotFoundException('Employee profile not found');
        }

        if (employee.user.status !== UserStatus.ACTIVE) {
            throw new ForbiddenException('Your account is inactive');
        }

        // 2. Validate assigned GPS location
        const locationValidation = await this.validateEmployeeLocation(
            employee.id,
            dto.latitude,
            dto.longitude,
            clientIp,
        );

        const now = new Date();

        // 3. Get today's date in India
        const dateParts = new Intl.DateTimeFormat('en-CA', {
            timeZone: 'Asia/Kolkata',
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
        }).format(now);

        const workDate = new Date(`${dateParts}T00:00:00.000Z`);

        // 4. Find open attendance session and punch out
        const result = await this.prisma.$transaction(async (tx) => {
            const record = await tx.attendanceRecord.findUnique({
                where: {
                    employeeProfileId_workDate: {
                        employeeProfileId: employee.id,
                        workDate,
                    },
                },
            });

            if (!record) {
                throw new NotFoundException(
                    'No attendance record found for today',
                );
            }

            // Serialize concurrent punch-out requests for this workday.
            await tx.$queryRaw`
                SELECT "id" FROM "attendance_records"
                WHERE "id" = ${record.id}::uuid
                FOR UPDATE
            `;

            // Do not allow another punch-out when any session already ended today.
            const completedSession = await tx.attendanceSession.findFirst({
                where: {
                    attendanceRecordId: record.id,
                    punchOutAt: { not: null },
                },
                select: { id: true },
            });
            if (completedSession) {
                throw new ConflictException(
                    'You have already punched out today. You can punch in again tomorrow.',
                );
            }

            const openSession = await tx.attendanceSession.findFirst({
                where: {
                    attendanceRecordId: record.id,
                    punchOutAt: null,
                },
                orderBy: {
                    punchInAt: 'desc',
                },
            });

            if (!openSession) {
                throw new ConflictException(
                    'You have not punched in or have already punched out',
                );
            }

            if (openSession.approvalStatus === 'PENDING') {
                throw new ForbiddenException(
                    'Your late arrival is awaiting Admin approval. You cannot punch out until it is approved.',
                );
            }

            if (openSession.approvalStatus === 'REJECTED') {
                throw new ForbiddenException(
                    'Your late arrival request was rejected. Please contact Admin.',
                );
            }

            const durationMs =
                now.getTime() - openSession.punchInAt.getTime();

            if (durationMs <= 0) {
                throw new ConflictException('Invalid punch-out time');
            }

            const sessionMinutes = Math.floor(durationMs / 60000);

            // 5. Save punch-out and GPS information
            const updatedSession = await tx.attendanceSession.update({
                where: { id: openSession.id },
                data: {
                    punchOutAt: now,
                    punchOutLatitude: dto.latitude,
                    punchOutLongitude: dto.longitude,
                    punchOutAccuracy: dto.accuracy,
                },
            });

            // 6. Calculate total completed working minutes
            const completedSessions = await tx.attendanceSession.findMany({
                where: {
                    attendanceRecordId: record.id,
                    punchOutAt: { not: null },
                    approvalStatus: {
                        in: ['NOT_REQUIRED', 'APPROVED'],
                    },
                },
                select: {
                    punchInAt: true,
                    punchOutAt: true,
                },
            });

            const totalWorkMinutes = completedSessions.reduce(
                (total, session) => {
                    if (!session.punchOutAt) return total;

                    const minutes = Math.floor(
                        (session.punchOutAt.getTime() -
                            session.punchInAt.getTime()) /
                        60000,
                    );

                    return total + Math.max(0, minutes);
                },
                0,
            );

            await tx.attendanceRecord.update({
                where: { id: record.id },
                data: { totalWorkMinutes },
            });

            return {
                message: 'Punch-out successful',
                assignedLocation: locationValidation.location.name,
                assignmentType: locationValidation.assignmentType,
                distanceMeters: locationValidation.distanceMeters,
                session: updatedSession,
                sessionWorkMinutes: sessionMinutes,
                totalWorkMinutes,
                totalWorkHours: Number(
                    (totalWorkMinutes / 60).toFixed(2),
                ),
            };
        });

        await this.auditLogsService.createLog({
            actorUserId: userId,
            action: 'ATTENDANCE_PUNCHED_OUT',
            entityType: 'ATTENDANCE_SESSION',
            entityId: result.session.id,
            description: `Employee ${employee.employeeCode} punched out`,
            metadata: {
                sessionWorkMinutes: result.sessionWorkMinutes,
                totalWorkMinutes: result.totalWorkMinutes,
                assignedLocation: locationValidation.location.name,
            },
        });

        return result;
    }
    async getPendingApprovals(actorUserId: string) {
        const organizationId = await this.getAdminOrganizationId(actorUserId);
        return this.prisma.attendanceSession.findMany({
            where: {
                approvalStatus: 'PENDING',
                ...(organizationId ? { attendanceRecord: { employeeProfile: { user: { organizationId } } } } : {}),
            },
            include: {
                attendanceRecord: {
                    include: {
                        employeeProfile: {
                            include: {
                                user: {
                                    select: {
                                        id: true,
                                        email: true,
                                    },
                                },
                                department: true,
                                shift: true,
                            },
                        },
                    },
                },
            },
            orderBy: {
                punchInAt: 'asc',
            },
        });
    }

    async reviewAttendance(
        sessionId: string,
        reviewerUserId: string,
        dto: ReviewAttendanceDto,
    ) {
        const organizationId = await this.getAdminOrganizationId(reviewerUserId);
        const result = await this.prisma.$transaction(async (tx) => {
            const session = await tx.attendanceSession.findUnique({
                where: { id: sessionId },
                include: {
                    attendanceRecord: {
                        include: {
                            employeeProfile: {
                                select: {
                                    userId: true,
                                    user: { select: { organizationId: true } },
                                },
                            },
                        },
                    },
                },
            });

            if (!session || (organizationId && session.attendanceRecord.employeeProfile.user.organizationId !== organizationId)) {
                throw new NotFoundException('Attendance session not found');
            }

            if (session.approvalStatus !== 'PENDING') {
                throw new ConflictException(
                    'This attendance request has already been reviewed',
                );
            }

            if (
                dto.action === 'REJECT' &&
                !dto.rejectionReason?.trim()
            ) {
                throw new ConflictException(
                    'Rejection reason is required',
                );
            }

            const result = await tx.attendanceSession.updateMany({
                where: {
                    id: sessionId,
                    approvalStatus: 'PENDING',
                },
                data: {
                    approvalStatus:
                        dto.action === 'APPROVE' ? 'APPROVED' : 'REJECTED',
                    reviewedByUserId: reviewerUserId,
                    reviewedAt: new Date(),
                    rejectionReason:
                        dto.action === 'REJECT'
                            ? dto.rejectionReason!.trim()
                            : null,
                },
            });

            if (result.count === 0) {
                throw new ConflictException(
                    'This attendance request has already been reviewed',
                );
            }

            if (dto.action === 'REJECT') {
                // Preserve the reviewed session and rejection reason as an
                // audit trail. Only change an attended day to ABSENT; never
                // override an explicitly recorded ON_LEAVE status.
                await tx.attendanceRecord.updateMany({
                    where: {
                        id: session.attendanceRecordId,
                        status: { in: [AttendanceStatus.LATE, AttendanceStatus.PRESENT] },
                    },
                    data: {
                        status: AttendanceStatus.ABSENT,
                        totalWorkMinutes: 0,
                    },
                });
            }

            await tx.notification.create({
                data: {
                    userId: session.attendanceRecord.employeeProfile.userId,
                    title:
                        dto.action === 'APPROVE'
                            ? 'Late Arrival Approved'
                            : 'Late Arrival Rejected',
                    message:
                        dto.action === 'APPROVE'
                            ? 'Your late arrival request has been approved.'
                            : `Your late arrival request was rejected. Reason: ${dto.rejectionReason!.trim()}`,
                    type: 'ATTENDANCE_APPROVAL',
                },
            });

            const updatedSession = await tx.attendanceSession.findUnique({
                where: { id: sessionId },
            });

            return {
                message:
                    dto.action === 'APPROVE'
                        ? 'Late arrival approved successfully'
                        : 'Late arrival rejected successfully',
                session: updatedSession,
            };
        });

        await this.auditLogsService.createLog({
            actorUserId: reviewerUserId,
            action: 'ATTENDANCE_APPROVAL_REVIEWED',
            entityType: 'ATTENDANCE_SESSION',
            entityId: sessionId,
            description: `Late arrival request ${dto.action.toLowerCase()}ed`,
            metadata: {
                decision: dto.action,
                rejectionReason: dto.rejectionReason ?? null,
            },
        });

        return result;
    }
    async getMissingPunchOuts(actorUserId: string) {
        const organizationId = await this.getAdminOrganizationId(actorUserId);
        const today = new Intl.DateTimeFormat('en-CA', {
            timeZone: 'Asia/Kolkata',
        }).format(new Date());

        const todayDate = new Date(`${today}T00:00:00.000Z`);

        return this.prisma.attendanceSession.findMany({
            where: {
                punchOutAt: null,
                approvalStatus: {
                    in: ['NOT_REQUIRED', 'APPROVED'],
                },
                attendanceRecord: {
                    workDate: { lt: todayDate },
                    ...(organizationId ? { employeeProfile: { user: { organizationId } } } : {}),
                },
            },
            include: {
                attendanceRecord: {
                    include: {
                        employeeProfile: {
                            include: {
                                user: {
                                    select: {
                                        id: true,
                                        email: true,
                                    },
                                },
                                department: true,
                                shift: true,
                            },
                        },
                    },
                },
            },
            orderBy: {
                punchInAt: 'asc',
            },
        });
    }
    async createAttendanceCorrection(
        userId: string,
        dto: CreateAttendanceCorrectionDto,
    ) {
        const employee = await this.prisma.employeeProfile.findUnique({
            where: { userId },
        });

        if (!employee) {
            throw new NotFoundException('Employee profile not found');
        }

        const session = await this.prisma.attendanceSession.findFirst({
            where: {
                id: dto.attendanceSessionId,
                attendanceRecord: {
                    employeeProfileId: employee.id,
                },
            },
        });

        if (!session) {
            throw new NotFoundException('Attendance session not found');
        }

        if (session.approvalStatus === 'PENDING' ||
            session.approvalStatus === 'REJECTED') {
            throw new ConflictException(
                'This attendance session is not eligible for correction',
            );
        }

        const requestedPunchInAt = new Date(dto.requestedPunchInAt);
        const requestedPunchOutAt = dto.requestedPunchOutAt
            ? new Date(dto.requestedPunchOutAt)
            : null;

        if (
            requestedPunchOutAt &&
            requestedPunchOutAt <= requestedPunchInAt
        ) {
            throw new ConflictException(
                'Punch-out time must be after punch-in time',
            );
        }

        if (
            requestedPunchInAt.getTime() === session.punchInAt.getTime() &&
            (requestedPunchOutAt?.getTime() ?? null) ===
            (session.punchOutAt?.getTime() ?? null)
        ) {
            throw new ConflictException('No attendance changes were requested');
        }

        if (!requestedPunchOutAt && session.punchOutAt) {
            throw new ConflictException(
                'Provide a punch-out time for this correction',
            );
        }

        const pendingRequest =
            await this.prisma.attendanceCorrectionRequest.findFirst({
                where: {
                    attendanceSessionId: session.id,
                    status: 'PENDING',
                },
            });

        if (pendingRequest) {
            throw new ConflictException(
                'A correction request is already pending for this session',
            );
        }

        const correction = await this.prisma.attendanceCorrectionRequest.create({
            data: {
                employeeProfileId: employee.id,
                attendanceSessionId: session.id,
                requestedByUserId: userId,
                originalPunchInAt: session.punchInAt,
                originalPunchOutAt: session.punchOutAt,
                requestedPunchInAt,
                requestedPunchOutAt,
                reason: dto.reason.trim(),
            },
        });

        await this.auditLogsService.createLog({
            actorUserId: userId,
            action: 'ATTENDANCE_CORRECTION_REQUESTED',
            entityType: 'ATTENDANCE_CORRECTION',
            entityId: correction.id,
            description: 'Employee submitted an attendance correction request',
            metadata: {
                attendanceSessionId: session.id,
                requestedPunchInAt: requestedPunchInAt.toISOString(),
                requestedPunchOutAt: requestedPunchOutAt?.toISOString() ?? null,
            },
        });

        return correction;
    }
    async getMyAttendanceCorrections(userId: string) {
        const employee = await this.prisma.employeeProfile.findUnique({
            where: { userId },
        });

        if (!employee) {
            throw new NotFoundException('Employee profile not found');
        }

        return this.prisma.attendanceCorrectionRequest.findMany({
            where: {
                employeeProfileId: employee.id,
            },
            include: {
                attendanceSession: true,
                reviewedBy: {
                    select: {
                        id: true,
                        email: true,
                    },
                },
            },
            orderBy: {
                createdAt: 'desc',
            },
        });
    }
    async getPendingAttendanceCorrections(actorUserId: string) {
        const organizationId = await this.getAdminOrganizationId(actorUserId);
        return this.prisma.attendanceCorrectionRequest.findMany({
            where: {
                status: 'PENDING',
                ...(organizationId ? { employeeProfile: { user: { organizationId } } } : {}),
            },
            include: {
                employeeProfile: {
                    include: {
                        user: {
                            select: {
                                id: true,
                                email: true,
                            },
                        },
                        department: true,
                        shift: true,
                    },
                },
                attendanceSession: true,
                requestedBy: {
                    select: {
                        id: true,
                        email: true,
                    },
                },
            },
            orderBy: {
                createdAt: 'asc',
            },
        });
    }
    async reviewAttendanceCorrection(
        requestId: string,
        reviewerUserId: string,
        dto: ReviewAttendanceCorrectionDto,
    ) {
        const organizationId = await this.getAdminOrganizationId(reviewerUserId);
        const result = await this.prisma.$transaction(async (tx) => {
            const request =
                await tx.attendanceCorrectionRequest.findUnique({
                    where: { id: requestId },
                    include: {
                        attendanceSession: true,
                        employeeProfile: {
                            select: {
                                userId: true,
                                user: { select: { organizationId: true } },
                            },
                        },
                    },
                });

            if (!request || (organizationId && request.employeeProfile.user.organizationId !== organizationId)) {
                throw new NotFoundException('Correction request not found');
            }

            if (request.status !== 'PENDING') {
                throw new ConflictException(
                    'This correction request has already been reviewed',
                );
            }

            if (
                dto.action === 'REJECT' &&
                !dto.rejectionReason?.trim()
            ) {
                throw new ConflictException(
                    'Rejection reason is required',
                );
            }

            if (dto.action === 'APPROVE') {
                const session = request.attendanceSession;

                if (
                    session.approvalStatus === 'PENDING' ||
                    session.approvalStatus === 'REJECTED'
                ) {
                    throw new ConflictException(
                        'Attendance session is not eligible for correction',
                    );
                }

                if (
                    request.requestedPunchOutAt &&
                    request.requestedPunchOutAt <= request.requestedPunchInAt
                ) {
                    throw new ConflictException(
                        'Punch-out time must be after punch-in time',
                    );
                }

                await tx.attendanceSession.update({
                    where: {
                        id: request.attendanceSessionId,
                    },
                    data: {
                        punchInAt: request.requestedPunchInAt,
                        punchOutAt: request.requestedPunchOutAt,
                    },
                });

                const sessions = await tx.attendanceSession.findMany({
                    where: {
                        attendanceRecordId: session.attendanceRecordId,
                        punchOutAt: { not: null },
                        approvalStatus: {
                            in: ['NOT_REQUIRED', 'APPROVED'],
                        },
                    },
                    select: {
                        punchInAt: true,
                        punchOutAt: true,
                    },
                });

                const totalWorkMinutes = sessions.reduce(
                    (total, item) => {
                        if (!item.punchOutAt) return total;

                        const minutes = Math.floor(
                            (item.punchOutAt.getTime() -
                                item.punchInAt.getTime()) / 60000,
                        );

                        return total + Math.max(0, minutes);
                    },
                    0,
                );

                await tx.attendanceRecord.update({
                    where: {
                        id: session.attendanceRecordId,
                    },
                    data: {
                        totalWorkMinutes,
                    },
                });
            }

            const result = await tx.attendanceCorrectionRequest.updateMany({
                where: {
                    id: requestId,
                    status: 'PENDING',
                },
                data: {
                    status:
                        dto.action === 'APPROVE' ? 'APPROVED' : 'REJECTED',
                    reviewedByUserId: reviewerUserId,
                    reviewedAt: new Date(),
                    rejectionReason:
                        dto.action === 'REJECT'
                            ? dto.rejectionReason!.trim()
                            : null,
                },
            });

            if (result.count === 0) {
                throw new ConflictException(
                    'This correction request has already been reviewed',
                );
            }

            await tx.notification.create({
                data: {
                    userId: request.employeeProfile.userId,
                    title:
                        dto.action === 'APPROVE'
                            ? 'Attendance Correction Approved'
                            : 'Attendance Correction Rejected',
                    message:
                        dto.action === 'APPROVE'
                            ? 'Your attendance correction request has been approved.'
                            : `Your attendance correction request was rejected. Reason: ${dto.rejectionReason!.trim()}`,
                    type: 'ATTENDANCE_CORRECTION',
                },
            });

            return {
                message:
                    dto.action === 'APPROVE'
                        ? 'Attendance correction approved successfully'
                        : 'Attendance correction rejected successfully',
            };
        });

        await this.auditLogsService.createLog({
            actorUserId: reviewerUserId,
            action: 'ATTENDANCE_CORRECTION_REVIEWED',
            entityType: 'ATTENDANCE_CORRECTION',
            entityId: requestId,
            description: `Attendance correction ${dto.action.toLowerCase()}ed`,
            metadata: {
                decision: dto.action,
                rejectionReason: dto.rejectionReason ?? null,
            },
        });

        return result;
    }
}
