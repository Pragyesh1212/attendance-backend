
import {
  Controller,
  Get,
  Patch,
  Param,
  Query,
  Req,
  UseGuards,
  ParseIntPipe,
  DefaultValuePipe,
  ParseBoolPipe,
} from '@nestjs/common';
import { Request } from 'express';

import { NotificationsService } from './notifications.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard/jwt-auth.guard';

interface AuthenticatedRequest extends Request {
  user: {
    sub: string;
    email: string;
    role: string;
  };
}

@Controller('notifications')
@UseGuards(JwtAuthGuard)
export class NotificationsController {
  constructor(
    private readonly notificationsService: NotificationsService,
  ) {}

  // GET /notifications
  @Get()
  getMyNotifications(
    @Req() request: AuthenticatedRequest,
    @Query('page', new DefaultValuePipe(1), ParseIntPipe)
    page: number,
    @Query('limit', new DefaultValuePipe(20), ParseIntPipe)
    limit: number,
    @Query('unreadOnly', new DefaultValuePipe(false), ParseBoolPipe)
    unreadOnly: boolean,
  ) {
    const safePage = Math.max(1, page);
    const safeLimit = Math.min(100, Math.max(1, limit));

    return this.notificationsService.getMyNotifications(
      request.user.sub,
      safePage,
      safeLimit,
      unreadOnly,
    );
  }

  // GET /notifications/unread-count
  @Get('unread-count')
  getUnreadCount(@Req() request: AuthenticatedRequest) {
    return this.notificationsService.getUnreadCount(
      request.user.sub,
    );
  }

  // PATCH /notifications/read-all
  @Patch('read-all')
  markAllAsRead(@Req() request: AuthenticatedRequest) {
    return this.notificationsService.markAllAsRead(
      request.user.sub,
    );
  }

  // PATCH /notifications/:id/read
  @Patch(':id/read')
  markAsRead(
    @Req() request: AuthenticatedRequest,
    @Param('id') notificationId: string,
  ) {
    return this.notificationsService.markAsRead(
      request.user.sub,
      notificationId,
    );
  }
}
