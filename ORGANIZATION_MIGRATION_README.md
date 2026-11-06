# Organization architecture — backend milestone 1

This milestone adds the organization model/API wiring and an additive PostgreSQL migration.

## Included
- Super Admin-only organization endpoints:
  - `POST /organizations` — create an organization
  - `GET /organizations` — list organizations with user/admin counts
  - `GET /organizations/:id` — organization details and related resource counts
  - `PATCH /organizations/:id` — rename or activate/deactivate
- Admin creation now requires `organizationId` and stores the admin under that organization.
- Admin listing supports an `organizationId` filter.
- Login response and authenticated request user now include `organizationId`.
- Optional `organizationId` ownership columns on departments, shifts and work locations.
- Additive SQL migration; existing records remain unassigned (`NULL`) pending your mapping.
- Reports HTTP module removed from application registration. Audit history tables/services are retained for data preservation and internal dependencies; the audit-log HTTP controller is no longer registered.

## Important status
This is **not yet the final multi-tenant release**. Employee, attendance, department, shift, work-location, correction, approval, notification and dashboard service queries still need organization scoping before this can be used with real organizations. Keep the app on a test database until that work is delivered. Never rely on frontend route hiding for authorization.

## Safe migration process
1. Back up the PostgreSQL database.
2. Review the SQL in `prisma/migrations/20261106010000_add_organization_scoping/migration.sql`.
3. Confirm your existing migration drift/history with `prisma migrate status` and database inspection.
4. Do not run `prisma migrate reset` or `db push` against the existing database.
5. Reconcile the existing drift first; then apply this migration through the agreed migration-history procedure.
6. Do not assign existing `users`, departments, shifts or work locations until the mapping is confirmed.

The SQL is additive and keeps existing user/resource rows. It creates the organizations table if absent and adds nullable ownership columns. The old global department/shift name indexes are replaced with organization/name indexes so names can repeat across tenants.

## Build checks performed in the provided workspace
- NestJS TypeScript build: passed (`node node_modules/@nestjs/cli/bin/nest.js build`).
- Prisma format/validate/generate: not verified in this environment because Prisma attempted to download its schema engine and network DNS was unavailable.
- Database migration: not applied; no database connection or reset was attempted.
