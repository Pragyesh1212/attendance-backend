import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateOrganizationDto } from './dto/create-organization.dto';
import { UpdateOrganizationDto } from './dto/update-organization.dto';

@Injectable()
export class OrganizationsService {
  constructor(private readonly prisma: PrismaService) {}

  async create(dto: CreateOrganizationDto) {
    const name = dto.name.trim();
    const exists = await this.prisma.organization.findUnique({ where: { name } });
    if (exists) throw new ConflictException('Organization name already exists');

    return {
      message: 'Organization created successfully',
      data: await this.prisma.organization.create({ data: { name } }),
    };
  }

  async findAll() {
    const organizations = await this.prisma.organization.findMany({
      orderBy: { createdAt: 'desc' },
      include: {
        _count: { select: { users: true } },
        users: {
          where: { role: 'ADMIN' },
          select: { id: true },
        },
      },
    });

    return {
      data: organizations.map(({ users, _count, ...organization }) => ({
        ...organization,
        userCount: _count.users,
        adminCount: users.length,
      })),
    };
  }

  async findOne(id: string) {
    const organization = await this.prisma.organization.findUnique({
      where: { id },
      include: {
        _count: { select: { users: true, departments: true, shifts: true, workLocations: true } },
      },
    });
    if (!organization) throw new NotFoundException('Organization not found');
    return { data: organization };
  }

  async update(id: string, dto: UpdateOrganizationDto) {
    const existing = await this.prisma.organization.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('Organization not found');

    const name = dto.name?.trim();
    if (name && name !== existing.name) {
      const duplicate = await this.prisma.organization.findUnique({ where: { name } });
      if (duplicate) throw new ConflictException('Organization name already exists');
    }

    return {
      message: 'Organization updated successfully',
      data: await this.prisma.organization.update({
        where: { id },
        data: { ...(name ? { name } : {}), ...(dto.status ? { status: dto.status } : {}) },
      }),
    };
  }
}
