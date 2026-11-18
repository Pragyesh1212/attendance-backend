import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client';
import { istWallClockAdapter } from './ist-timestamp-adapter';

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  constructor() {
    const pg = new PrismaPg({ connectionString: process.env.DATABASE_URL! });
    const mode = process.env.ATTENDANCE_TIMESTAMP_STORAGE ?? 'UTC';
    if (mode !== 'UTC' && mode !== 'IST') {
      throw new Error('ATTENDANCE_TIMESTAMP_STORAGE must be UTC or IST');
    }
    // Remain in legacy UTC mode until the database is migrated. Switching this
    // flag without the matching database conversion WILL corrupt date handling.
    super({ adapter: mode === 'IST' ? istWallClockAdapter(pg) : pg });
  }

  async onModuleInit() {
    await this.$connect();
    console.log('Database connected successfully');
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }
}
