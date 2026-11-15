import { Body, Controller, Get, Param, Patch, Post, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { CurrentUser } from '../auth/decorators/current-user/current-user';
import { Roles } from '../auth/decorators/roles.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { DevicesService } from './devices.service';

@Controller('devices')
@UseGuards(JwtAuthGuard, RolesGuard)
export class DevicesController {
  constructor(private readonly devices: DevicesService) {}
  @Get('me')
  @Roles('EMPLOYEE')
  mine(@CurrentUser() user: { sub: string }) { return this.devices.mine(user.sub); }

  @Post('register/challenge')
  @Roles('EMPLOYEE')
  registerChallenge(@CurrentUser() user: { sub: string }) { return this.devices.registerChallenge(user.sub); }

  @Post('register')
  @Roles('EMPLOYEE')
  register(@CurrentUser() user: { sub: string }, @Body() body: Record<string, unknown>, @Req() req: Request) {
    return this.devices.register(user.sub, body, req.ip ?? '');
  }

  @Post(':id/auth/challenge')
  @Roles('EMPLOYEE')
  authChallenge(@CurrentUser() user: { sub: string }, @Param('id') deviceId: string) {
    return this.devices.authChallenge(user.sub, deviceId);
  }

  @Post('auth/verify')
  @Roles('EMPLOYEE')
  authVerify(@CurrentUser() user: { sub: string }, @Body() body: Record<string, unknown>, @Req() req: Request) {
    return this.devices.authVerify(user.sub, body, req.ip ?? '');
  }

  @Get('admin/employee/:userId')
  @Roles('ADMIN')
  forAdmin(@CurrentUser() user: { sub: string }, @Param('userId') employeeUserId: string) {
    return this.devices.forAdmin(user.sub, employeeUserId);
  }

  @Patch('admin/:id/approve')
  @Roles('ADMIN')
  approve(@CurrentUser() user: { sub: string }, @Param('id') id: string) {
    return this.devices.changeDevice(user.sub, id, 'approve');
  }

  @Patch('admin/:id/revoke')
  @Roles('ADMIN')
  revoke(@CurrentUser() user: { sub: string }, @Param('id') id: string) {
    return this.devices.changeDevice(user.sub, id, 'revoke');
  }

  @Patch('admin/:id/reactivate')
  @Roles('ADMIN')
  reactivate(@CurrentUser() user: { sub: string }, @Param('id') id: string) {
    return this.devices.changeDevice(user.sub, id, 'reactivate');
  }

  @Patch('admin/:id/rename')
  @Roles('ADMIN')
  rename(@CurrentUser() user: { sub: string }, @Param('id') id: string, @Body() body: { label?: string }) {
    return this.devices.changeDevice(user.sub, id, 'rename', body.label);
  }
}
