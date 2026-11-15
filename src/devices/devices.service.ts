import {
  BadRequestException, ConflictException, ForbiddenException, Injectable,
  NotFoundException, UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { createHash, createHmac, createPublicKey, randomBytes, verify as verifySignature } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import { EmployeeDeviceStatus } from '../generated/prisma/client';

const MAX_ACTIVE_DEVICES = 2;
const CHALLENGE_LIFETIME_MS = 5 * 60 * 1000;
const PROOF_LIFETIME_SECONDS = 45;

const safeText = (v: unknown, max: number) => typeof v === 'string' ? v.trim().slice(0, max) : '';
const fingerprint = (spki: Buffer) => createHash('sha256').update(spki).digest('hex');

@Injectable()
export class DevicesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
    private readonly audit: AuditLogsService,
  ) {}

  // A separate signing key prevents a device proof from ever being accepted as an access JWT.
  private proofSecret(): string {
    const access = this.config.getOrThrow<string>('JWT_ACCESS_SECRET');
    return createHmac('sha256', access).update('attendease-device-proof-v1').digest('hex');
  }

  private async employee(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId }, select: { id: true, role: true, status: true, email: true, organizationId: true },
    });
    if (!user || user.role !== 'EMPLOYEE' || user.status !== 'ACTIVE') {
      throw new ForbiddenException('Only active employees can register attendance devices');
    }
    return user;
  }

  private async adminTarget(adminId: string, employeeUserId: string) {
    const admin = await this.prisma.user.findUnique({
      where: { id: adminId }, select: { role: true, status: true, organizationId: true },
    });
    if (!admin || admin.status !== 'ACTIVE' || admin.role !== 'ADMIN' || !admin.organizationId) {
      throw new ForbiddenException('Only an active organization Admin can manage employee devices');
    }
    const employee = await this.prisma.user.findFirst({
      where: { id: employeeUserId, role: 'EMPLOYEE', organizationId: admin.organizationId },
      select: { id: true },
    });
    if (!employee) throw new NotFoundException('Employee not found in your organization');
    return employee;
  }

  private async newChallenge(userId: string, purpose: 'REGISTER' | 'AUTHENTICATE', deviceId?: string) {
    const nonce = randomBytes(32).toString('base64url');
    const record = await this.prisma.employeeDeviceChallenge.create({
      data: {
        userId, deviceId: deviceId ?? null, purpose, challenge: nonce,
        expiresAt: new Date(Date.now() + CHALLENGE_LIFETIME_MS),
      },
    });
    return { challengeId: record.id, challenge: nonce };
  }

  private async readChallenge(userId: string, id: string, purpose: string, deviceId?: string) {
    const challenge = await this.prisma.employeeDeviceChallenge.findFirst({
      where: { id, userId, purpose, deviceId: deviceId ?? null, usedAt: null, expiresAt: { gt: new Date() } },
    });
    if (!challenge) throw new BadRequestException('Device challenge expired or already used');
    return challenge;
  }

  private verifyKey(publicKeySpki: string, message: string, signature: string): boolean {
    try {
      const spki = Buffer.from(publicKeySpki, 'base64url');
      if (spki.length < 70 || spki.length > 512 || signature.length > 256) return false;
      const key = createPublicKey({ key: spki, format: 'der', type: 'spki' });
      if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1') return false;
      // WebCrypto ECDSA signatures use IEEE-P1363, not ASN.1 DER.
      return verifySignature('sha256', Buffer.from(message),
        { key, dsaEncoding: 'ieee-p1363' }, Buffer.from(signature, 'base64url'));
    } catch { return false; }
  }

  private deviceView(device: {
    id: string; label: string; deviceType: string | null; operatingSystem: string | null;
    browser: string | null; status: EmployeeDeviceStatus; createdAt: Date;
    lastSeenAt: Date | null; lastIp: string | null; approvedAt: Date | null; revokedAt: Date | null;
  }) {
    return { id: device.id, label: device.label, deviceType: device.deviceType,
      operatingSystem: device.operatingSystem, browser: device.browser, status: device.status,
      createdAt: device.createdAt, lastSeenAt: device.lastSeenAt,
      approvedAt: device.approvedAt, revokedAt: device.revokedAt, lastIp: device.lastIp };
  }

  async mine(userId: string) {
    await this.employee(userId);
    const devices = await this.prisma.employeeDevice.findMany({ where: { userId }, orderBy: { createdAt: 'asc' } });
    return { maxDevices: MAX_ACTIVE_DEVICES, devices: devices.map(d => this.deviceView(d)) };
  }

  async registerChallenge(userId: string) {
    await this.employee(userId);
    return this.newChallenge(userId, 'REGISTER');
  }

  async register(userId: string, body: Record<string, unknown>, ip: string) {
    await this.employee(userId);
    const challengeId = safeText(body.challengeId, 80);
    const publicKeySpki = safeText(body.publicKeySpki, 1024);
    const signature = safeText(body.signature, 256);
    if (!challengeId || !publicKeySpki || !signature) throw new BadRequestException('Device key proof is required');
    const challenge = await this.readChallenge(userId, challengeId, 'REGISTER');
    const message = `attendease:register:v1:${challenge.id}:${challenge.challenge}`;
    if (!this.verifyKey(publicKeySpki, message, signature)) {
      throw new ForbiddenException('The registered browser could not prove possession of its key');
    }
    const hash = fingerprint(Buffer.from(publicKeySpki, 'base64url'));
    const result = await this.prisma.$transaction(async tx => {
      // Serialize parallel enrollments for the same employee to enforce the two-device limit.
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${userId}::text)) IS NULL AS acquired`;
      const used = await tx.employeeDeviceChallenge.updateMany({
        where: { id: challenge.id, userId, usedAt: null, expiresAt: { gt: new Date() } },
        data: { usedAt: new Date() },
      });
      if (used.count !== 1) throw new ConflictException('Registration challenge already used');
      const existing = await tx.employeeDevice.findUnique({ where: { keyFingerprint: hash } });
      if (existing) {
        if (existing.userId !== userId) throw new ForbiddenException('Credential belongs to another employee');
        if (existing.status === 'REVOKED') throw new ForbiddenException('This device was revoked. Contact your Admin');
        return existing;
      }
      const activeCount = await tx.employeeDevice.count({
        where: { userId, status: { in: ['PENDING', 'APPROVED'] } },
      });
      if (activeCount >= MAX_ACTIVE_DEVICES) {
        throw new ConflictException('Two devices are already registered or awaiting approval. Ask Admin to revoke one before replacing it');
      }
      return tx.employeeDevice.create({ data: {
        userId, keyFingerprint: hash, publicKeySpki,
        label: safeText(body.label, 120) || 'Employee browser',
        deviceType: safeText(body.deviceType, 32) || null,
        operatingSystem: safeText(body.operatingSystem, 100) || null,
        browser: safeText(body.browser, 100) || null,
        userAgent: safeText(body.userAgent, 500) || null,
        lastIp: safeText(ip, 45) || null,
      } });
    });
    await this.audit.createLog({ actorUserId: userId, action: 'EMPLOYEE_DEVICE_ENROLLED',
      entityType: 'EMPLOYEE_DEVICE', entityId: result.id, description: 'Device credential registered and awaiting Admin approval' });
    return this.deviceView(result);
  }

  async authChallenge(userId: string, deviceId: string) {
    await this.employee(userId);
    const device = await this.prisma.employeeDevice.findFirst({
      where: { id: deviceId, userId, status: 'APPROVED' },
    });
    if (!device) throw new ForbiddenException('Your browser is not approved for attendance');
    return this.newChallenge(userId, 'AUTHENTICATE', deviceId);
  }

  async authVerify(userId: string, body: Record<string, unknown>, ip: string) {
    await this.employee(userId);
    const id = safeText(body.deviceId, 80);
    const challengeId = safeText(body.challengeId, 80);
    const signature = safeText(body.signature, 256);
    const device = await this.prisma.employeeDevice.findFirst({ where: { id, userId, status: 'APPROVED' } });
    if (!device) throw new ForbiddenException('Your browser is not approved for attendance');
    const challenge = await this.readChallenge(userId, challengeId, 'AUTHENTICATE', device.id);
    if (!this.verifyKey(device.publicKeySpki,
      `attendease:authenticate:v1:${challenge.id}:${challenge.challenge}`, signature)) {
      throw new ForbiddenException('Device verification failed');
    }
    const result = await this.prisma.employeeDeviceChallenge.updateMany({
      where: { id: challenge.id, usedAt: null, expiresAt: { gt: new Date() } },
      data: { usedAt: new Date() },
    });
    if (result.count !== 1) throw new ConflictException('Device proof already used');
    await this.prisma.employeeDevice.update({
      where: { id: device.id }, data: { lastSeenAt: new Date(), lastIp: safeText(ip, 45) || null },
    });
    const proof = await this.jwt.signAsync(
      { sub: userId, deviceId: device.id, typ: 'attendance-device' },
      { secret: this.proofSecret(), expiresIn: PROOF_LIFETIME_SECONDS, audience: 'attendease-attendance' },
    );
    return { proof, expiresInSeconds: PROOF_LIFETIME_SECONDS };
  }

  async validatePunchProof(userId: string, proof?: string): Promise<string> {
    if (!proof) throw new ForbiddenException('An approved device is required for Punch In/Out');
    let payload: { sub: string; deviceId: string; typ: string };
    try {
      payload = await this.jwt.verifyAsync(proof, {
        secret: this.proofSecret(), audience: 'attendease-attendance',
      });
    } catch { throw new ForbiddenException('Device verification expired. Please retry'); }
    if (payload.sub !== userId || payload.typ !== 'attendance-device') {
      throw new ForbiddenException('Device proof does not match the signed-in employee');
    }
    const device = await this.prisma.employeeDevice.findFirst({
      where: { id: payload.deviceId, userId, status: 'APPROVED' }, select: { id: true },
    });
    if (!device) throw new ForbiddenException('Device approval has been revoked');
    return device.id;
  }

  async forAdmin(adminId: string, employeeUserId: string) {
    await this.adminTarget(adminId, employeeUserId);
    const devices = await this.prisma.employeeDevice.findMany({
      where: { userId: employeeUserId }, orderBy: { createdAt: 'asc' },
    });
    return { maxDevices: MAX_ACTIVE_DEVICES, devices: devices.map(d => this.deviceView(d)) };
  }

  async changeDevice(adminId: string, deviceId: string, action: 'approve' | 'revoke' | 'reactivate' | 'rename', label?: string) {
    const existing = await this.prisma.employeeDevice.findUnique({ where: { id: deviceId } });
    if (!existing) throw new NotFoundException('Device not found');
    await this.adminTarget(adminId, existing.userId);
    const changed = await this.prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${existing.userId}::text)) IS NULL AS acquired`;
      const current = await tx.employeeDevice.findUniqueOrThrow({ where: { id: deviceId } });
      if (action === 'rename') {
        const next = safeText(label, 120);
        if (!next) throw new BadRequestException('Device name is required');
        return tx.employeeDevice.update({ where: { id: deviceId }, data: { label: next } });
      }
      if (action === 'revoke') {
        if (current.status === 'REVOKED') return current;
        return tx.employeeDevice.update({ where: { id: deviceId }, data: { status: 'REVOKED', revokedAt: new Date() } });
      }
      if (current.status === 'APPROVED') return current;
      const activeCount = await tx.employeeDevice.count({
        where: { userId: current.userId, status: { in: ['PENDING', 'APPROVED'] }, id: { not: deviceId } },
      });
      if (activeCount >= MAX_ACTIVE_DEVICES) throw new ConflictException('Maximum two approved devices per employee');
      return tx.employeeDevice.update({ where: { id: deviceId }, data: {
        status: 'APPROVED', approvedByUserId: adminId, approvedAt: new Date(), revokedAt: null,
      } });
    });
    await this.audit.createLog({ actorUserId: adminId, action: `EMPLOYEE_DEVICE_${action.toUpperCase()}`,
      entityType: 'EMPLOYEE_DEVICE', entityId: deviceId,
      description: `Admin ${action} device registration`, metadata: { employeeUserId: existing.userId } });
    return this.deviceView(changed);
  }
}
