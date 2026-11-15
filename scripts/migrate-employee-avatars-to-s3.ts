/**
 * One-time migration from employee_avatars.content (PostgreSQL bytea) to S3.
 * Dry run by default: npx tsx scripts/migrate-employee-avatars-to-s3.ts
 * Apply only after DB backup and S3 setup:
 *   npx tsx scripts/migrate-employee-avatars-to-s3.ts --apply
 *
 * Each migrated row is deleted only after the S3 upload AND matching profile URL
 * have been saved together in PostgreSQL. Re-running is safe for remaining rows.
 */
import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../src/generated/prisma/client';
import { EmployeeS3AvatarStorageService } from '../src/employees/employee-s3-avatar-storage.service';

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL must be configured');
  const apply = process.argv.includes('--apply');
  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }) });
  const s3 = new EmployeeS3AvatarStorageService();
  let migrated = 0;
  let skipped = 0;
  let failed = 0;
  let lastId: string | undefined;

  try {
    if (!apply) {
      const count = await prisma.employeeAvatar.count();
      console.log(`DRY RUN: ${count} employee photos still have database-stored bytes.`);
      console.log('No files or database records were modified. Add --apply after making a backup.');
      return;
    }
    // Make sure S3 is configured before starting. The write also checks credentials.
    if (!process.env.AWS_REGION || !process.env.S3_EMPLOYEE_AVATARS_BUCKET) {
      throw new Error('AWS_REGION and S3_EMPLOYEE_AVATARS_BUCKET are required');
    }

    while (true) {
      const batch = await prisma.employeeAvatar.findMany({
        where: lastId ? { employeeProfileId: { gt: lastId } } : {},
        orderBy: { employeeProfileId: 'asc' }, take: 25,
        include: { employeeProfile: { select: { userId: true, avatarUrl: true } } },
      });
      if (batch.length === 0) break;
      for (const row of batch) {
        lastId = row.employeeProfileId;
        const existingUrl = row.employeeProfile.avatarUrl;
        if (existingUrl && s3.isManagedUrl(existingUrl)) {
          // Never delete bytes until a separate verification of an already-migrated URL.
          console.warn(`Skipping ${row.employeeProfile.userId}: profile already has an S3 URL.`);
          skipped++;
          continue;
        }
        let url: string | undefined;
        try {
          url = await s3.upload(row.employeeProfile.userId, Buffer.from(row.content), row.mimeType);
          await prisma.$transaction([
            prisma.employeeProfile.update({ where: { id: row.employeeProfileId }, data: { avatarUrl: url } }),
            prisma.employeeAvatar.delete({ where: { employeeProfileId: row.employeeProfileId } }),
          ]);
          migrated++;
          console.log(`Migrated ${row.employeeProfile.userId}`);
        } catch (error) {
          failed++;
          if (url) {
            try { await s3.deleteManaged(url); }
            catch (cleanupError) { console.error('Orphan S3 object cleanup failed', cleanupError); }
          }
          console.error(`Could not migrate ${row.employeeProfile.userId}`, error);
        }
      }
    }
    console.log(`Migration finished: ${migrated} migrated, ${skipped} skipped, ${failed} failed.`);
    if (failed) process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
