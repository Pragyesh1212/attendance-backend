import { Module } from '@nestjs/common';
import { AuditLogsService } from './audit-logs.service';

// Audit history is retained internally for existing service dependencies and data
// preservation. Its HTTP controller is intentionally not registered as a feature.
@Module({ providers: [AuditLogsService], exports: [AuditLogsService] })
export class AuditLogsModule {}
