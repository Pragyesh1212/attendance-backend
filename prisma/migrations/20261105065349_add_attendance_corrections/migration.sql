-- CreateEnum
CREATE TYPE "AttendanceCorrectionStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

-- CreateTable
CREATE TABLE "attendance_correction_requests" (
    "id" UUID NOT NULL,
    "employeeProfileId" UUID NOT NULL,
    "attendanceSessionId" UUID NOT NULL,
    "requestedByUserId" UUID NOT NULL,
    "reviewedByUserId" UUID,
    "originalPunchInAt" TIMESTAMP(3) NOT NULL,
    "originalPunchOutAt" TIMESTAMP(3),
    "requestedPunchInAt" TIMESTAMP(3) NOT NULL,
    "requestedPunchOutAt" TIMESTAMP(3),
    "reason" VARCHAR(500) NOT NULL,
    "status" "AttendanceCorrectionStatus" NOT NULL DEFAULT 'PENDING',
    "reviewedAt" TIMESTAMP(3),
    "rejectionReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "attendance_correction_requests_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "attendance_correction_requests_employeeProfileId_idx" ON "attendance_correction_requests"("employeeProfileId");

-- CreateIndex
CREATE INDEX "attendance_correction_requests_attendanceSessionId_idx" ON "attendance_correction_requests"("attendanceSessionId");

-- CreateIndex
CREATE INDEX "attendance_correction_requests_status_idx" ON "attendance_correction_requests"("status");

-- AddForeignKey
ALTER TABLE "attendance_correction_requests" ADD CONSTRAINT "attendance_correction_requests_employeeProfileId_fkey" FOREIGN KEY ("employeeProfileId") REFERENCES "employee_profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attendance_correction_requests" ADD CONSTRAINT "attendance_correction_requests_attendanceSessionId_fkey" FOREIGN KEY ("attendanceSessionId") REFERENCES "attendance_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attendance_correction_requests" ADD CONSTRAINT "attendance_correction_requests_requestedByUserId_fkey" FOREIGN KEY ("requestedByUserId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attendance_correction_requests" ADD CONSTRAINT "attendance_correction_requests_reviewedByUserId_fkey" FOREIGN KEY ("reviewedByUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
