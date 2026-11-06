
import {
    Injectable,
    UnauthorizedException,
    InternalServerErrorException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import * as argon2 from 'argon2';

import { PrismaService } from '../prisma/prisma.service';
import { LoginDto } from './dto/login.dto';

@Injectable()
export class AuthService {
    constructor(
        private readonly prisma: PrismaService,
        private readonly jwtService: JwtService,
        private readonly configService: ConfigService,
    ) { }

    async login(loginDto: LoginDto) {
        const email = loginDto.email.trim().toLowerCase();

        const user = await this.prisma.user.findUnique({
            where: { email },
            include: {
                employeeProfile: true,
            adminProfile: true,
            organization: { select: { id: true, name: true, status: true } },
            },
        });

        if (!user) {
            throw new UnauthorizedException('Invalid email or password');
        }

        if (user.status !== 'ACTIVE') {
            throw new UnauthorizedException('Your account is not active');
        }

        const passwordValid = await argon2.verify(
            user.passwordHash,
            loginDto.password,
        );

        if (!passwordValid) {
            throw new UnauthorizedException('Invalid email or password');
        }

        const payload = {
            sub: user.id,
            email: user.email,
            role: user.role,
            organizationId: user.organizationId,
        };

        const accessSecret = this.configService.get<string>('JWT_ACCESS_SECRET');
        const refreshSecret = this.configService.get<string>('JWT_REFRESH_SECRET');

        if (!accessSecret || !refreshSecret) {
            throw new InternalServerErrorException(
                'Authentication configuration is missing',
            );
        }

        const [accessToken, refreshToken] = await Promise.all([
            this.jwtService.signAsync(payload, {
                secret: accessSecret,
                expiresIn: '15m',
            }),
            this.jwtService.signAsync(payload, {
                secret: refreshSecret,
                expiresIn: '7d',
            }),
        ]);

        const refreshTokenHash = await argon2.hash(refreshToken);

        await this.prisma.user.update({
            where: { id: user.id },
            data: {
                lastLoginAt: new Date(),
                refreshTokenHash: refreshTokenHash,
            },
        });

        return {
            message: 'Login successful',
            accessToken,
            refreshToken,
            user: {
                id: user.id,
                email: user.email,
                role: user.role,
                organizationId: user.organizationId,
                organization: user.organization,
                adminProfile: user.adminProfile,
                employeeProfile: user.employeeProfile,
            },
        };
    }

    async refreshTokens(refreshToken: string) {
        const refreshSecret = this.configService.get<string>(
            'JWT_REFRESH_SECRET',
        );
        const accessSecret = this.configService.get<string>(
            'JWT_ACCESS_SECRET',
        );

        if (!refreshSecret || !accessSecret) {
            throw new UnauthorizedException('Invalid authentication configuration');
        }

        let payload: { sub: string; email: string; role: string };

        try {
            payload = await this.jwtService.verifyAsync(refreshToken, {
                secret: refreshSecret,
            });
        } catch {
            throw new UnauthorizedException('Invalid or expired refresh token');
        }

        const user = await this.prisma.user.findUnique({
            where: { id: payload.sub },
        });

        if (!user || user.status !== 'ACTIVE' || !user.refreshTokenHash) {
            throw new UnauthorizedException('Session is invalid or expired');
        }

        const tokenMatches = await argon2.verify(
            user.refreshTokenHash,
            refreshToken,
        );

        if (!tokenMatches) {
            // Revoke the current refresh-token session on reuse detection.
            await this.prisma.user.update({
                where: { id: user.id },
                data: { refreshTokenHash: null },
            });

            throw new UnauthorizedException('Invalid or expired refresh token');
        }

        const newPayload = {
            sub: user.id,
            email: user.email,
            role: user.role,
            organizationId: user.organizationId,
        };

        const [newAccessToken, newRefreshToken] = await Promise.all([
            this.jwtService.signAsync(newPayload, {
                secret: accessSecret,
                expiresIn: '15m',
            }),
            this.jwtService.signAsync(newPayload, {
                secret: refreshSecret,
                expiresIn: '7d',
            }),
        ]);

        const newRefreshTokenHash = await argon2.hash(newRefreshToken);

        await this.prisma.user.update({
            where: { id: user.id },
            data: { refreshTokenHash: newRefreshTokenHash },
        });

        return {
            accessToken: newAccessToken,
            refreshToken: newRefreshToken,
        };
    }

    async logout(userId: string) {
        await this.prisma.user.updateMany({
            where: { id: userId },
            data: { refreshTokenHash: null },
        });

        return {
            message: 'Logged out successfully',
        };
    }

}
