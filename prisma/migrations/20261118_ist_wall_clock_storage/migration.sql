-- AttendEase: convert existing *UTC wall clock* values to IST wall clock
-- in their original timestamp-without-time-zone columns.
-- ONE TIME ONLY. MUST RUN WITH ALL APP WRITERS STOPPED ON A TEST/CLONE BRANCH FIRST.
-- After this migration, the application MUST use ATTENDANCE_TIMESTAMP_STORAGE=IST
-- with the accompanying Prisma driver adapter (or writes/reads will be wrong).
--
-- Do not convert the date-only fields: attendance_records.workDate,
-- employee_day_overrides.workDate (already DATE); employee_profiles.joiningDate
-- is converted to DATE without moving the calendar date.
-- Do not convert _prisma_migrations (timestamptz / Prisma internal metadata).
BEGIN;
-- Existing user-created IST view was only for viewing UTC data; it would
-- double-adjust the new values. It is no longer needed after this migration.
DROP VIEW IF EXISTS public.attendance_sessions_ist;

-- Shift *all* app TIMESTAMP WITHOUT TIME ZONE columns on real tables.
-- Automatically includes present and future added timestamp columns as of
-- migration time, except explicitly excluded date-only employee joiningDate.
DO $ist_migration$
DECLARE
    rec record;
BEGIN
    FOR rec IN
        SELECT n.nspname AS schema_name, c.relname AS table_name,
               a.attname AS column_name
        FROM pg_catalog.pg_class c
        JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
        JOIN pg_catalog.pg_attribute a ON a.attrelid = c.oid
        WHERE n.nspname = 'public'
          AND c.relkind = 'r'
          AND a.attnum > 0 AND NOT a.attisdropped
          AND a.atttypid = 'timestamp without time zone'::regtype
          AND c.relname <> '_prisma_migrations'
          AND NOT (c.relname = 'employee_profiles' AND a.attname = 'joiningDate')
        ORDER BY c.relname, a.attnum
    LOOP
        EXECUTE format(
          'UPDATE %I.%I SET %I = (%I AT TIME ZONE ''UTC'') AT TIME ZONE ''Asia/Kolkata'' WHERE %I IS NOT NULL',
          rec.schema_name, rec.table_name,
          rec.column_name, rec.column_name, rec.column_name
        );
    END LOOP;
END;
$ist_migration$;

-- Make database-side DEFAULT now() write local IST wall-clock values too.
-- Prisma @updatedAt and explicitly supplied JS Dates are handled by the
-- accompanying adapter; this block handles database-side current timestamps.
DO $ist_defaults$
DECLARE
    rec record;
BEGIN
    FOR rec IN
        SELECT n.nspname AS schema_name, c.relname AS table_name,
               a.attname AS column_name,
               pg_get_expr(d.adbin, d.adrelid) AS expression
        FROM pg_catalog.pg_class c
        JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
        JOIN pg_catalog.pg_attribute a ON a.attrelid = c.oid
        JOIN pg_catalog.pg_attrdef d ON d.adrelid = c.oid AND d.adnum = a.attnum
        WHERE n.nspname = 'public'
          AND c.relkind = 'r'
          AND a.attnum > 0 AND NOT a.attisdropped
          AND a.atttypid = 'timestamp without time zone'::regtype
          AND c.relname <> '_prisma_migrations'
          AND pg_get_expr(d.adbin, d.adrelid) IN
              ('now()', 'CURRENT_TIMESTAMP', 'transaction_timestamp()')
    LOOP
        EXECUTE format(
          'ALTER TABLE %I.%I ALTER COLUMN %I SET DEFAULT (CURRENT_TIMESTAMP AT TIME ZONE ''Asia/Kolkata'')',
          rec.schema_name, rec.table_name, rec.column_name
        );
    END LOOP;
END;
$ist_defaults$;

-- Business calendar date: do not apply a timezone offset to a joining date.
-- Store it as DATE using the original column, not another column.
ALTER TABLE public.employee_profiles
  ALTER COLUMN "joiningDate" TYPE date USING "joiningDate"::date;



COMMIT;