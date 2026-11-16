-- Add-only migration. Does not modify existing attendance tables or data.
CREATE TABLE "attendance_location_alerts" (
    "attendanceLocationAlertId" UUID NOT NULL,
    "attendanceSessionId" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "workLocationId" UUID NOT NULL,
    "workLocationName" VARCHAR(150) NOT NULL,
    "workLocationLatitude" DOUBLE PRECISION NOT NULL,
    "workLocationLongitude" DOUBLE PRECISION NOT NULL,
    "radiusMeters" INTEGER NOT NULL,
    "exitLatitude" DOUBLE PRECISION NOT NULL,
    "exitLongitude" DOUBLE PRECISION NOT NULL,
    "exitAccuracy" DOUBLE PRECISION NOT NULL,
    "exitLocationName" VARCHAR(300),
    "leftAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "returnedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "attendance_location_alerts_pkey" PRIMARY KEY ("attendanceLocationAlertId")
);
CREATE INDEX "attendance_location_alerts_attendanceSessionId_returnedAt_idx" ON "attendance_location_alerts"("attendanceSessionId", "returnedAt");
CREATE INDEX "attendance_location_alerts_organizationId_leftAt_idx" ON "attendance_location_alerts"("organizationId", "leftAt");
CREATE INDEX "attendance_location_alerts_workLocationId_leftAt_idx" ON "attendance_location_alerts"("workLocationId", "leftAt");
-- A session may only have one unreturned exit episode at a time.
CREATE UNIQUE INDEX "attendance_location_alert_one_open_per_session"
ON "attendance_location_alerts"("attendanceSessionId") WHERE "returnedAt" IS NULL;
ALTER TABLE "attendance_location_alerts"
ADD CONSTRAINT "attendance_location_alerts_attendanceSessionId_fkey"
FOREIGN KEY ("attendanceSessionId") REFERENCES "attendance_sessions"("attendanceSessionId")
ON DELETE CASCADE ON UPDATE CASCADE;
