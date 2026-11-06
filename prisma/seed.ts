import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient, UserRole, UserStatus } from '../src/generated/prisma/client';
import * as argon2 from 'argon2';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';

async function main() {
  const databaseUrl = process.env.DATABASE_URL;

  if (!databaseUrl) {
    throw new Error('DATABASE_URL is not configured');
  }

  const rl = createInterface({ input: stdin, output: stdout });

  try {
    const email = (
      await rl.question('Enter Super Admin email: ')
    ).trim().toLowerCase();

    const password = await rl.question('Enter Super Admin password: ');

    if (!email || !password || password.length < 12) {
      throw new Error('Provide a valid email and a password of at least 12 characters.');
    }

    const adapter = new PrismaPg({ connectionString: databaseUrl });
    const prisma = new PrismaClient({ adapter });

    try {
      const existingAdmin = await prisma.user.findFirst({
        where: { role: UserRole.SUPER_ADMIN },
      });

      if (existingAdmin) {
        throw new Error('A Super Admin already exists. Seed operation cancelled.');
      }

      const existingUser = await prisma.user.findUnique({
        where: { email },
      });

      if (existingUser) {
        throw new Error('This email already belongs to an existing user.');
      }

      const passwordHash = await argon2.hash(password);

      await prisma.user.create({
        data: {
          email,
          passwordHash,
          role: UserRole.SUPER_ADMIN,
          status: UserStatus.ACTIVE,
          emailVerifiedAt: new Date(),
        },
      });

      console.log('Super Admin created successfully.');
    } finally {
      await prisma.$disconnect();
    }
  } finally {
    rl.close();
  }
}

main().catch((error) => {
  console.error('Super Admin seeding failed:', error.message);
  process.exitCode = 1;
});