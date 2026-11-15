-- Add a date-specific employee calendar. Existing attendance records remain unchanged.
CREATE TYPE "EmployeeDayType" AS ENUM ('WEEKEND', 'HOLIDAY');
CREATE TABLE "employee_day_overrides" (
    "employeeDayOverrideId" UUID NOT NULL,
    "employeeProfileId" UUID NOT NULL,
    "workDate" DATE NOT NULL,
    "dayType" "EmployeeDayType" NOT NULL,
    "note" VARCHAR(500),
    "updatedByUserId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "employee_day_overrides_pkey" PRIMARY KEY ("employeeDayOverrideId")
);
CREATE UNIQUE INDEX "employee_day_overrides_employeeProfileId_workDate_key" ON "employee_day_overrides"("employeeProfileId", "workDate");
CREATE INDEX "employee_day_overrides_workDate_idx" ON "employee_day_overrides"("workDate");
ALTER TABLE "employee_day_overrides" ADD CONSTRAINT "employee_day_overrides_employeeProfileId_fkey" FOREIGN KEY ("employeeProfileId") REFERENCES "employee_profiles"("employeeProfileId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "employee_day_overrides" ADD CONSTRAINT "employee_day_overrides_updatedByUserId_fkey" FOREIGN KEY ("updatedByUserId") REFERENCES "users"("userId") ON DELETE RESTRICT ON UPDATE CASCADE;
