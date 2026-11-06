
import {
    Injectable,
    NotFoundException,
    ForbiddenException,
    ConflictException,
    InternalServerErrorException,
} from '@nestjs/common';

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
export class AttendanceService {
    constructor(
        private readonly prisma: PrismaService,
        private readonly workLocationsService: WorkLocationsService,
        private readonly auditLogsService: AuditLogsService,
    ) { }

    // Verify that the request comes from an authorized office public IP.
    private validateOfficeNetwork(clientIp: string): void {
        const allowedIps = (process.env.OFFICE_PUBLIC_IPS ?? '')
            .split(',')
            .map((ip) => ip.trim())
            .filter(Boolean);
        console.log('Allowed office IPs:', allowedIps);
        console.log('Client IP:', clientIp);
        console.log(process.env.OFFICE_PUBLIC_IPS);
        if (allowedIps.length === 0) {
            throw new InternalServerErrorException(
                'Office network configuration is missing',
            );
        }

        const normalizeIp = (ip: string) =>
            ip.trim().replace(/^::ffff:/i, '');

        const normalizedClientIp = normalizeIp(clientIp);
        const isAuthorized = allowedIps.some(
            (ip) => normalizeIp(ip) === normalizedClientIp,
        );

        if (!normalizedClientIp || !isAuthorized) {
            throw new ForbiddenException(
                'You must connect to the authorized office network to mark attendance.',
            );
        }
    }

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
    ) {
        const effectiveLocation =
            await this.workLocationsService.getEffectiveLocation(
                employeeProfileId,
            );

        const location = effectiveLocation.location;

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
    async getAllAttendance(query: GetAttendanceDto) {
        return this.getAttendanceRecords(
            query.employeeProfileId,
            query,
        );
    }

    // COMMON ATTENDANCE HISTORY QUERY
    private async getAttendanceRecords(
        employeeProfileId: string | undefined,
        query: GetAttendanceDto,
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
    async getAttendanceById(id: string) {
        const record = await this.prisma.attendanceRecord.findUnique({
            where: { id },
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

    // PUNCH IN
    async punchIn(userId: string, dto: PunchInDto, clientIp: string) {
        this.validateOfficeNetwork(clientIp);
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

        // 2. Validate assigned GPS location
        const locationValidation = await this.validateEmployeeLocation(
            employee.id,
            dto.latitude,
            dto.longitude,
        );

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
        const rawMinutesLate = currentMinutes - shiftStartMinutes;

        const minutesLate = Math.max(0, rawMinutesLate);

        // These three settings are independent:
        // - gracePeriodMinutes controls the LATE attendance classification.
        // - lateReasonAfterMinutes controls whether a reason is mandatory.
        // - approvalRequiredAfterMinutes controls whether admin approval is mandatory.
        // Both thresholds are measured from shift start, not from the end of grace.
        const gracePeriodMinutes = assignedShift.gracePeriodMinutes ?? 0;
        const lateReasonAfterMinutes =
            assignedShift.lateReasonAfterMinutes ?? null;
        const approvalRequiredAfterMinutes =
            assignedShift.approvalRequiredAfterMinutes ?? null;

        const isLate = minutesLate > gracePeriodMinutes;

        const lateReasonRequired =
            lateReasonAfterMinutes !== null &&
            minutesLate >= lateReasonAfterMinutes;

        const approvalRequired =
            isLate &&
            approvalRequiredAfterMinutes !== null &&
            minutesLate >= approvalRequiredAfterMinutes;

        // A reason is mandatory either when the late-reason threshold is
        // reached OR when Admin approval is required. This guarantees that
        // every approval request includes an employee explanation.
        const reasonRequired = lateReasonRequired || approvalRequired;

        if (reasonRequired && !dto.lateReason?.trim()) {
            throw new ConflictException(
                approvalRequired
                    ? `You are ${minutesLate} minutes late and Admin approval is required. Please provide a reason for your late arrival.`
                    : `You are ${minutesLate} minutes late. Please provide a reason for your late arrival.`,
            );
        }

        const approvalStatus = approvalRequired
            ? 'PENDING'
            : 'NOT_REQUIRED';

        const attendanceStatus = isLate
            ? AttendanceStatus.LATE
            : AttendanceStatus.PRESENT;

        // 5. Create or retrieve today's attendance record
        const result = await this.prisma.$transaction(async (tx) => {
            let record = await tx.attendanceRecord.findUnique({
                where: {
                    employeeProfileId_workDate: {
                        employeeProfileId: employee.id,
                        workDate,
                    },
                },
            });

            if (!record) {
                record = await tx.attendanceRecord.create({
                    data: {
                        employeeProfileId: employee.id,
                        workDate,
                        status: attendanceStatus,
                    },
                });
            } else if (
                record.status === AttendanceStatus.PRESENT &&
                isLate
            ) {
                record = await tx.attendanceRecord.update({
                    where: { id: record.id },
                    data: { status: AttendanceStatus.LATE },
                });
            }

            // 6. Prevent duplicate open punch-in
            const openSession = await tx.attendanceSession.findFirst({
                where: {
                    attendanceRecordId: record.id,
                    punchOutAt: null,
                },
                orderBy: {
                    punchInAt: 'desc',
                },
            });

            if (openSession?.approvalStatus === 'PENDING') {
                throw new ForbiddenException(
                    'Your late arrival request is awaiting Admin approval. You cannot punch in again until it is reviewed.',
                );
            }

            if (openSession?.approvalStatus === 'REJECTED') {
                throw new ForbiddenException(
                    'Your late arrival request was rejected. Please contact Admin before continuing.',
                );
            }

            if (openSession) {
                throw new ConflictException(
                    'You are already punched in. Please punch out first.',
                );
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
                    lateReasonAfterMinutes,
                    approvalRequiredAfterMinutes,
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
    async punchOut(userId: string, dto: PunchOutDto, clientIp: string) {
        this.validateOfficeNetwork(clientIp);
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
    async getPendingApprovals() {
        return this.prisma.attendanceSession.findMany({
            where: {
                approvalStatus: 'PENDING',
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
        const result = await this.prisma.$transaction(async (tx) => {
            const session = await tx.attendanceSession.findUnique({
                where: { id: sessionId },
                include: {
                    attendanceRecord: {
                        include: {
                            employeeProfile: {
                                select: {
                                    userId: true,
                                },
                            },
                        },
                    },
                },
            });

            if (!session) {
                throw new NotFoundException(
                    'Attendance session not found',
                );
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
    async getMissingPunchOuts() {
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
    async getPendingAttendanceCorrections() {
        return this.prisma.attendanceCorrectionRequest.findMany({
            where: {
                status: 'PENDING',
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
        const result = await this.prisma.$transaction(async (tx) => {
            const request =
                await tx.attendanceCorrectionRequest.findUnique({
                    where: { id: requestId },
                    include: {
                        attendanceSession: true,
                        employeeProfile: {
                            select: {
                                userId: true,
                            },
                        },
                    },
                });

            if (!request) {
                throw new NotFoundException(
                    'Correction request not found',
                );
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
