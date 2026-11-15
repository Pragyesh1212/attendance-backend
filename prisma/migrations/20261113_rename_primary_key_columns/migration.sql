-- AttendEase primary-key column naming migration
-- PostgreSQL RENAME COLUMN keeps existing UUID values and updates dependent PK/FK definitions.
-- Keep Prisma field names as `id` using @map("...").
-- DO NOT APPLY until the two raw SQL references in NestJS attendance.service.ts are updated and the dev database connection is reconfirmed.

BEGIN;

ALTER TABLE "users" RENAME COLUMN "id" TO "userId";
ALTER TABLE "employee_profiles" RENAME COLUMN "id" TO "employeeProfileId";
ALTER TABLE "admin_profiles" RENAME COLUMN "id" TO "adminProfileId";
ALTER TABLE "departments" RENAME COLUMN "id" TO "departmentId";
ALTER TABLE "shifts" RENAME COLUMN "id" TO "shiftId";
ALTER TABLE "attendance_records" RENAME COLUMN "id" TO "attendanceRecordId";
ALTER TABLE "attendance_sessions" RENAME COLUMN "id" TO "attendanceSessionId";
ALTER TABLE "work_locations" RENAME COLUMN "id" TO "workLocationId";
ALTER TABLE "location_assignments" RENAME COLUMN "id" TO "locationAssignmentId";
ALTER TABLE "attendance_correction_requests" RENAME COLUMN "id" TO "attendanceCorrectionRequestId";
ALTER TABLE "notifications" RENAME COLUMN "id" TO "notificationId";
ALTER TABLE "audit_logs" RENAME COLUMN "id" TO "auditLogId";
ALTER TABLE "organizations" RENAME COLUMN "id" TO "organizationId";

COMMIT;
