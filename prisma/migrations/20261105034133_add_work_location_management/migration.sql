-- CreateEnum
CREATE TYPE "WorkLocationType" AS ENUM ('OFFICE', 'REMOTE', 'MEETING', 'FIELD');

-- CreateEnum
CREATE TYPE "WorkLocationStatus" AS ENUM ('ACTIVE', 'INACTIVE');

-- AlterTable
ALTER TABLE "employee_profiles" ADD COLUMN     "workLocationId" UUID;

-- CreateTable
CREATE TABLE "work_locations" (
    "id" UUID NOT NULL,
    "name" VARCHAR(150) NOT NULL,
    "type" "WorkLocationType" NOT NULL,
    "address" TEXT,
    "latitude" DOUBLE PRECISION NOT NULL,
    "longitude" DOUBLE PRECISION NOT NULL,
    "radiusMeters" INTEGER NOT NULL DEFAULT 100,
    "status" "WorkLocationStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "work_locations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "location_assignments" (
    "id" UUID NOT NULL,
    "employeeProfileId" UUID NOT NULL,
    "workLocationId" UUID NOT NULL,
    "createdByUserId" UUID NOT NULL,
    "startAt" TIMESTAMP(3) NOT NULL,
    "endAt" TIMESTAMP(3) NOT NULL,
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "location_assignments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "work_locations_status_idx" ON "work_locations"("status");

-- CreateIndex
CREATE INDEX "location_assignments_employeeProfileId_startAt_endAt_idx" ON "location_assignments"("employeeProfileId", "startAt", "endAt");

-- CreateIndex
CREATE INDEX "location_assignments_workLocationId_idx" ON "location_assignments"("workLocationId");

-- CreateIndex
CREATE INDEX "employee_profiles_workLocationId_idx" ON "employee_profiles"("workLocationId");

-- AddForeignKey
ALTER TABLE "employee_profiles" ADD CONSTRAINT "employee_profiles_workLocationId_fkey" FOREIGN KEY ("workLocationId") REFERENCES "work_locations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "location_assignments" ADD CONSTRAINT "location_assignments_employeeProfileId_fkey" FOREIGN KEY ("employeeProfileId") REFERENCES "employee_profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "location_assignments" ADD CONSTRAINT "location_assignments_workLocationId_fkey" FOREIGN KEY ("workLocationId") REFERENCES "work_locations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "location_assignments" ADD CONSTRAINT "location_assignments_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
