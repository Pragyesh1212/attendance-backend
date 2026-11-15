-- Employee browser-key enrollment: two active registrations, Admin approval, attendance-only proof.
-- Adds tables and nullable audit links. No existing attendance data is deleted or renamed.
BEGIN;
CREATE TYPE "EmployeeDeviceStatus" AS ENUM ('PENDING', 'APPROVED', 'REVOKED');

CREATE TABLE "employee_devices" (
  "employeeDeviceId" UUID NOT NULL,
  "userId" UUID NOT NULL,
  "keyFingerprint" VARCHAR(64) NOT NULL,
  "publicKeySpki" TEXT NOT NULL,
  "label" VARCHAR(120) NOT NULL,
  "deviceType" VARCHAR(32),
  "operatingSystem" VARCHAR(100),
  "browser" VARCHAR(100),
  "userAgent" VARCHAR(500),
  "status" "EmployeeDeviceStatus" NOT NULL DEFAULT 'PENDING',
  "approvedByUserId" UUID,
  "approvedAt" TIMESTAMP(3),
  "revokedAt" TIMESTAMP(3),
  "lastSeenAt" TIMESTAMP(3),
  "lastIp" VARCHAR(45),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "employee_devices_pkey" PRIMARY KEY ("employeeDeviceId")
);
CREATE UNIQUE INDEX "employee_devices_keyFingerprint_key" ON "employee_devices"("keyFingerprint");
CREATE INDEX "employee_devices_userId_status_idx" ON "employee_devices"("userId", "status");
ALTER TABLE "employee_devices" ADD CONSTRAINT "employee_devices_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("userId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "employee_devices" ADD CONSTRAINT "employee_devices_approvedByUserId_fkey" FOREIGN KEY ("approvedByUserId") REFERENCES "users"("userId") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "employee_device_challenges" (
  "employeeDeviceChallengeId" UUID NOT NULL,
  "userId" UUID NOT NULL,
  "deviceId" UUID,
  "purpose" VARCHAR(20) NOT NULL,
  "challenge" VARCHAR(128) NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "usedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "employee_device_challenges_pkey" PRIMARY KEY ("employeeDeviceChallengeId")
);
CREATE INDEX "employee_device_challenges_userId_expiresAt_idx" ON "employee_device_challenges"("userId", "expiresAt");
ALTER TABLE "employee_device_challenges" ADD CONSTRAINT "employee_device_challenges_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("userId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "employee_device_challenges" ADD CONSTRAINT "employee_device_challenges_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "employee_devices"("employeeDeviceId") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "attendance_sessions" ADD COLUMN "punchInDeviceId" UUID;
ALTER TABLE "attendance_sessions" ADD COLUMN "punchOutDeviceId" UUID;
ALTER TABLE "attendance_sessions" ADD CONSTRAINT "attendance_sessions_punchInDeviceId_fkey" FOREIGN KEY ("punchInDeviceId") REFERENCES "employee_devices"("employeeDeviceId") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "attendance_sessions" ADD CONSTRAINT "attendance_sessions_punchOutDeviceId_fkey" FOREIGN KEY ("punchOutDeviceId") REFERENCES "employee_devices"("employeeDeviceId") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX "attendance_sessions_punchInDeviceId_idx" ON "attendance_sessions"("punchInDeviceId");
CREATE INDEX "attendance_sessions_punchOutDeviceId_idx" ON "attendance_sessions"("punchOutDeviceId");

COMMIT;
