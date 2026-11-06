
import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

interface CreateAuditLogDto {
  actorUserId?: string;
  action: string;
  entityType: string;
  entityId?: string;
  description: string;
  metadata?: Record<string, any>;
  ipAddress?: string;
  userAgent?: string;
}

interface AuditLogFilters {
  page?: number;
  limit?: number;
  action?: string;
  entityType?: string;
  actorUserId?: string;
  startDate?: string;
  endDate?: string;
}

@Injectable()
export class AuditLogsService {
  constructor(private readonly prisma: PrismaService) {}

  async createLog(dto: CreateAuditLogDto) {
    return this.prisma.auditLog.create({
      data: {
        actorUserId: dto.actorUserId,
        action: dto.action,
        entityType: dto.entityType,
        entityId: dto.entityId,
        description: dto.description,
        metadata: dto.metadata,
        ipAddress: dto.ipAddress,
        userAgent: dto.userAgent,
      },
    });
  }

  async getLogs(filters: AuditLogFilters) {
    const page = Math.max(1, filters.page ?? 1);
    const limit = Math.min(100, Math.max(1, filters.limit ?? 20));

    const where: any = {
      ...(filters.action ? { action: filters.action } : {}),
      ...(filters.entityType ? { entityType: filters.entityType } : {}),
      ...(filters.actorUserId
        ? { actorUserId: filters.actorUserId }
        : {}),
      ...(filters.startDate || filters.endDate
        ? {
            createdAt: {
              ...(filters.startDate
                ? { gte: new Date(filters.startDate) }
                : {}),
              ...(filters.endDate
                ? { lte: new Date(filters.endDate) }
                : {}),
            },
          }
        : {}),
    };

    const [logs, total] = await Promise.all([
      this.prisma.auditLog.findMany({
        where,
        include: {
          actor: {
            select: {
              id: true,
              email: true,
              role: true,
            },
          },
        },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.auditLog.count({ where }),
    ]);

    return {
      logs,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    };
  }
}
