-- Preserve assigned shift count per workday even when employee assignments later change.
ALTER TABLE "attendance_records" ADD COLUMN "assignedShiftCount" INTEGER NOT NULL DEFAULT 1;

-- Non-destructive: existing shiftId and attendance sessions are preserved.
-- New employees use ordered assignments; legacy one-shift employees are backfilled below.
CREATE TABLE "employee_shift_assignments" (
  "id" UUID NOT NULL,
  "employeeProfileId" UUID NOT NULL,
  "shiftId" UUID NOT NULL,
  "sequence" INTEGER NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "employee_shift_assignments_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "employee_shift_assignments_employeeProfileId_sequence_key" ON "employee_shift_assignments"("employeeProfileId", "sequence");
CREATE UNIQUE INDEX "employee_shift_assignments_employeeProfileId_shiftId_key" ON "employee_shift_assignments"("employeeProfileId", "shiftId");
CREATE INDEX "employee_shift_assignments_shiftId_idx" ON "employee_shift_assignments"("shiftId");
ALTER TABLE "employee_shift_assignments" ADD CONSTRAINT "employee_shift_assignments_employeeProfileId_fkey" FOREIGN KEY ("employeeProfileId") REFERENCES "employee_profiles"("employeeProfileId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "employee_shift_assignments" ADD CONSTRAINT "employee_shift_assignments_shiftId_fkey" FOREIGN KEY ("shiftId") REFERENCES "shifts"("shiftId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Backfill all previously assigned single shifts (keeping the old column).
INSERT INTO "employee_shift_assignments" ("id", "employeeProfileId", "shiftId", "sequence", "updatedAt")
SELECT gen_random_uuid(), "employeeProfileId", "shiftId", 1, NOW()
FROM "employee_profiles" WHERE "shiftId" IS NOT NULL;

ALTER TABLE "attendance_sessions" ADD COLUMN "shiftOrder" INTEGER;
ALTER TABLE "attendance_sessions" ADD COLUMN "shiftId" UUID;
ALTER TABLE "attendance_sessions" ADD COLUMN "shiftName" VARCHAR(100);
ALTER TABLE "attendance_sessions" ADD COLUMN "shiftStartTime" VARCHAR(5);
ALTER TABLE "attendance_sessions" ADD COLUMN "shiftEndTime" VARCHAR(5);
CREATE UNIQUE INDEX "attendance_sessions_attendanceRecordId_shiftOrder_key" ON "attendance_sessions"("attendanceRecordId", "shiftOrder");
CREATE INDEX "attendance_sessions_shiftId_idx" ON "attendance_sessions"("shiftId");
ALTER TABLE "attendance_sessions" ADD CONSTRAINT "attendance_sessions_shiftId_fkey" FOREIGN KEY ("shiftId") REFERENCES "shifts"("shiftId") ON DELETE SET NULL ON UPDATE CASCADE;
-- Preserve old session meaning for reports without requiring a guessed time window.
UPDATE "attendance_sessions" AS s SET
  "shiftOrder" = 1,
  "shiftId" = ep."shiftId",
  "shiftName" = sh."name",
  "shiftStartTime" = sh."startTime",
  "shiftEndTime" = sh."endTime"
FROM "attendance_records" ar
LEFT JOIN "employee_profiles" ep ON ep."employeeProfileId" = ar."employeeProfileId"
LEFT JOIN "shifts" sh ON sh."shiftId" = ep."shiftId"
WHERE s."attendanceRecordId" = ar."attendanceRecordId"
  AND (SELECT COUNT(*) FROM "attendance_sessions" sx WHERE sx."attendanceRecordId" = ar."attendanceRecordId") = 1;

CREATE TABLE "employee_avatars" (
  "employeeProfileId" UUID NOT NULL,
  "content" BYTEA NOT NULL,
  "mimeType" VARCHAR(30) NOT NULL,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "employee_avatars_pkey" PRIMARY KEY ("employeeProfileId")
);
ALTER TABLE "employee_avatars" ADD CONSTRAINT "employee_avatars_employeeProfileId_fkey" FOREIGN KEY ("employeeProfileId") REFERENCES "employee_profiles"("employeeProfileId") ON DELETE CASCADE ON UPDATE CASCADE;
