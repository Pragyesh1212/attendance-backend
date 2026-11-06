-- Additive, non-destructive organization scoping migration.
-- Existing rows intentionally remain organizationId = NULL until an explicit mapping is supplied.

DO $$ BEGIN
  CREATE TYPE "OrganizationStatus" AS ENUM ('ACTIVE', 'INACTIVE');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS "organizations" (
  "id" UUID NOT NULL,
  "name" VARCHAR(150) NOT NULL,
  "status" "OrganizationStatus" NOT NULL DEFAULT 'ACTIVE',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "organizations_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "organizations_name_key" ON "organizations"("name");
CREATE INDEX IF NOT EXISTS "organizations_status_idx" ON "organizations"("status");

ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "organizationId" UUID;
ALTER TABLE "departments" ADD COLUMN IF NOT EXISTS "organizationId" UUID;
ALTER TABLE "shifts" ADD COLUMN IF NOT EXISTS "organizationId" UUID;
ALTER TABLE "work_locations" ADD COLUMN IF NOT EXISTS "organizationId" UUID;

-- Drop previous global name uniqueness only after confirming current constraints exist.
DROP INDEX IF EXISTS "departments_name_key";
DROP INDEX IF EXISTS "shifts_name_key";

CREATE UNIQUE INDEX IF NOT EXISTS "departments_organizationId_name_key"
  ON "departments"("organizationId", "name");
CREATE UNIQUE INDEX IF NOT EXISTS "shifts_organizationId_name_key"
  ON "shifts"("organizationId", "name");
CREATE INDEX IF NOT EXISTS "users_organizationId_idx" ON "users"("organizationId");
CREATE INDEX IF NOT EXISTS "departments_organizationId_idx" ON "departments"("organizationId");
CREATE INDEX IF NOT EXISTS "shifts_organizationId_idx" ON "shifts"("organizationId");
CREATE INDEX IF NOT EXISTS "work_locations_organizationId_idx" ON "work_locations"("organizationId");

DO $$ BEGIN
  ALTER TABLE "users" ADD CONSTRAINT "users_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE "departments" ADD CONSTRAINT "departments_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE "shifts" ADD CONSTRAINT "shifts_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE "work_locations" ADD CONSTRAINT "work_locations_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
