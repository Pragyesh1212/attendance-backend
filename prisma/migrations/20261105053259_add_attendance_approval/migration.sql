-- CreateEnum
CREATE TYPE "AttendanceApprovalStatus" AS ENUM ('NOT_REQUIRED', 'PENDING', 'APPROVED', 'REJECTED');

-- AlterTable
ALTER TABLE "attendance_sessions" ADD COLUMN     "approvalStatus" "AttendanceApprovalStatus" NOT NULL DEFAULT 'NOT_REQUIRED',
ADD COLUMN     "lateMinutes" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "lateReason" TEXT,
ADD COLUMN     "rejectionReason" TEXT,
ADD COLUMN     "reviewedAt" TIMESTAMP(3),
ADD COLUMN     "reviewedByUserId" UUID;

-- CreateIndex
CREATE INDEX "attendance_sessions_approvalStatus_idx" ON "attendance_sessions"("approvalStatus");

-- CreateIndex
CREATE INDEX "attendance_sessions_reviewedByUserId_idx" ON "attendance_sessions"("reviewedByUserId");

-- AddForeignKey
ALTER TABLE "attendance_sessions" ADD CONSTRAINT "attendance_sessions_reviewedByUserId_fkey" FOREIGN KEY ("reviewedByUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
