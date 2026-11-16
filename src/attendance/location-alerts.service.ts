import {
  BadRequestException, ForbiddenException, Injectable,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { WorkLocationsService } from '../work-locations/work-locations.service';
import { LocationAlertEventDto } from './dto/location-alert-event.dto';

interface AlertFilters {
  date?: string;
  employeeName?: string;
  status?: string;
  workLocationId?: string;
  page?: string;
  limit?: string;
}

@Injectable()
export class LocationAlertsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly workLocations: WorkLocationsService,
  ) {}

  private lastReverseGeocodeAt = 0;
  private reverseGeocodeQueue: Promise<unknown> = Promise.resolve();
  private readonly resolvedNames = new Map<string, string | null>();
  // Avoid repeatedly looking up the same historical alert on every Admin poll.
  private readonly attemptedAddressBackfills = new Set<string>();

  private distanceMeters(lat1: number, lon1: number, lat2: number, lon2: number): number {
    const toRad = (degrees: number) => (degrees * Math.PI) / 180;
    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
    return 6371000 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(Math.max(0, 1 - h)));
  }

  /**
   * Optional Nominatim-compatible reverse-geocoder (self-hosted / contracted provider).
   * Disabled by default: sending employee coordinates to an external service
   * requires an explicit operator choice and employee privacy disclosure.
   */
  private async reverseGeocode(lat: number, lon: number): Promise<string | null> {
    const endpoint = process.env.ATTENDANCE_REVERSE_GEOCODE_URL?.trim();
    if (!endpoint) return null;
    const key = `${lat.toFixed(4)},${lon.toFixed(4)}`;
    if (this.resolvedNames.has(key)) return this.resolvedNames.get(key) ?? null;

    // One query at a time, at most ~1 request/second for this server process.
    const task = this.reverseGeocodeQueue.catch(() => {}).then(async () => {
      if (this.resolvedNames.has(key)) return this.resolvedNames.get(key) ?? null;
      const pause = Math.max(0, this.lastReverseGeocodeAt + 1200 - Date.now());
      if (pause) await new Promise<void>(resolve => setTimeout(resolve, pause));
      this.lastReverseGeocodeAt = Date.now();
      try {
        const url = new URL(endpoint);
        if (url.protocol !== 'https:') return null;
        url.searchParams.set('lat', String(lat));
        url.searchParams.set('lon', String(lon));
        url.searchParams.set('format', 'json');
        url.searchParams.set('zoom', '16');
        url.searchParams.set('addressdetails', '0');
        const response = await fetch(url, {
          headers: {
            'User-Agent': 'AttendEase/1.0',
            'Accept': 'application/json',
            'Accept-Language': 'en',
          },
          signal: AbortSignal.timeout(4500),
        });
        if (!response.ok) return null;
        const payload: unknown = await response.json();
        const displayName = typeof payload === 'object' && payload !== null && 'display_name' in payload
          ? (payload as { display_name?: unknown }).display_name : null;
        const name = typeof displayName === 'string' ? displayName.slice(0, 300) : null;
        if (this.resolvedNames.size >= 500) this.resolvedNames.clear();
        this.resolvedNames.set(key, name);
        return name;
      } catch {
        return null;
      }
    });
    this.reverseGeocodeQueue = task;
    return task;
  }

  /**
   * Enrich a limited number of existing alerts which were saved before a
   * geocoder was configured. Never delay an Admin page response for geocoding.
   * After enrichment, the existing 30-second Admin refresh displays the name.
   */
  private queueMissingExitNames(alerts: Array<{
    id: string; exitLatitude: number; exitLongitude: number;
    exitLocationName: string | null;
  }>): void {
    if (!process.env.ATTENDANCE_REVERSE_GEOCODE_URL?.trim()) return;

    const missing = alerts.filter(alert =>
      !alert.exitLocationName && !this.attemptedAddressBackfills.has(alert.id)
    ).slice(0, 2);

    for (const alert of missing) {
      this.attemptedAddressBackfills.add(alert.id);
      void this.reverseGeocode(alert.exitLatitude, alert.exitLongitude)
        .then(async name => {
          if (!name) return;
          // Don't overwrite an address set by a concurrent request.
          await this.prisma.attendanceLocationAlert.updateMany({
            where: { id: alert.id, exitLocationName: null },
            data: { exitLocationName: name },
          });
        })
        .catch(() => {
          // Geocoder availability never blocks attendance or the Admin page.
        });
    }
  }

  private async getActiveEmployeeContext(userId: string, dto: LocationAlertEventDto) {
    const session = await this.prisma.attendanceSession.findFirst({
      where: {
        id: dto.sessionId,
        punchOutAt: null,
        approvalStatus: { in: ['NOT_REQUIRED', 'APPROVED'] },
        attendanceRecord: { employeeProfile: { userId, user: { status: 'ACTIVE', role: 'EMPLOYEE' } } },
      },
      include: {
        attendanceRecord: {
          include: { employeeProfile: { include: { user: { select: { organizationId: true } } } } },
        },
      },
    });
    if (!session) throw new ForbiddenException('No authorized active attendance session');
    const employee = session.attendanceRecord.employeeProfile;
    if (!employee.user.organizationId) throw new ForbiddenException('Employee has no organization');
    const { location } = await this.workLocations.getEffectiveLocation(employee.id);
    if (location.id !== dto.workLocationId) {
      throw new ForbiddenException('Assigned work location has changed; refresh monitoring');
    }
    return { session, location, organizationId: employee.user.organizationId };
  }

  async reportExit(userId: string, dto: LocationAlertEventDto) {
    const { session, location, organizationId } = await this.getActiveEmployeeContext(userId, dto);
    const distance = this.distanceMeters(dto.latitude, dto.longitude, location.latitude, location.longitude);
    // Use the same conservative accuracy-circle rule as the existing browser monitor.
    if (distance - dto.accuracy <= location.radiusMeters) {
      throw new BadRequestException('GPS reading does not reliably confirm an exit');
    }
    const alreadyOpen = await this.prisma.attendanceLocationAlert.findFirst({
      where: { attendanceSessionId: session.id, returnedAt: null },
    });
    if (alreadyOpen) return { id: alreadyOpen.id, status: 'OUTSIDE', created: false };

    try {
      const alert = await this.prisma.attendanceLocationAlert.create({
        data: {
          attendanceSessionId: session.id,
          organizationId,
          workLocationId: location.id,
          workLocationName: location.name,
          workLocationLatitude: location.latitude,
          workLocationLongitude: location.longitude,
          radiusMeters: location.radiusMeters,
          exitLatitude: dto.latitude,
          exitLongitude: dto.longitude,
          exitAccuracy: dto.accuracy,
        },
      });
      // Resolve once per exit episode, never on five-second GPS polls.
      const name = await this.reverseGeocode(dto.latitude, dto.longitude);
      if (name) {
        await this.prisma.attendanceLocationAlert.update({
          where: { id: alert.id }, data: { exitLocationName: name },
        });
      }
      return { id: alert.id, status: 'OUTSIDE', created: true };
    } catch (error) {
      // The partial unique index avoids concurrent duplicate open episodes.
      const existing = await this.prisma.attendanceLocationAlert.findFirst({
        where: { attendanceSessionId: session.id, returnedAt: null },
      });
      if (existing) return { id: existing.id, status: 'OUTSIDE', created: false };
      throw error;
    }
  }

  async reportReturn(userId: string, dto: LocationAlertEventDto) {
    const { session, location } = await this.getActiveEmployeeContext(userId, dto);
    const distance = this.distanceMeters(dto.latitude, dto.longitude, location.latitude, location.longitude);
    if (distance + dto.accuracy >= location.radiusMeters) {
      throw new BadRequestException('GPS reading does not reliably confirm re-entry');
    }
    const open = await this.prisma.attendanceLocationAlert.findFirst({
      where: { attendanceSessionId: session.id, returnedAt: null },
      orderBy: { leftAt: 'desc' },
    });
    if (!open) return { status: 'NO_OPEN_ALERT' };
    const result = await this.prisma.attendanceLocationAlert.updateMany({
      where: { id: open.id, returnedAt: null },
      data: { returnedAt: new Date() },
    });
    return { id: open.id, status: result.count ? 'RETURNED' : 'ALREADY_RETURNED' };
  }

  private indiaDate(): string {
    const formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit',
    });
    const p = Object.fromEntries(formatter.formatToParts(new Date()).map(x => [x.type, x.value]));
    return `${p.year}-${p.month}-${p.day}`;
  }

  async getAlerts(actorId: string, filter: AlertFilters) {
    const actor = await this.prisma.user.findUnique({
      where: { id: actorId }, select: { status: true, role: true, organizationId: true },
    });
    if (!actor || actor.status !== 'ACTIVE' || actor.role !== 'ADMIN' || !actor.organizationId) {
      throw new ForbiddenException('Admin organization access required');
    }
    const date = filter.date || this.indiaDate();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(`${date}T00:00:00+05:30`))) {
      throw new BadRequestException('Invalid date: expected YYYY-MM-DD');
    }
    const page = filter.page === undefined ? 1 : Number(filter.page);
    const limit = filter.limit === undefined ? 20 : Number(filter.limit);
    if (!Number.isInteger(page) || page < 1 || !Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new BadRequestException('Invalid pagination');
    }
    if (filter.status && !['OUTSIDE', 'RETURNED'].includes(filter.status)) {
      throw new BadRequestException('Unknown status filter');
    }
    if (filter.workLocationId && !/^[0-9a-fA-F-]{36}$/.test(filter.workLocationId)) {
      throw new BadRequestException('Invalid work location');
    }
    const start = new Date(`${date}T00:00:00+05:30`);
    const end = new Date(start.getTime() + 86400000);
    const base = {
      organizationId: actor.organizationId,
      // Revalidate org membership from the live database, not merely an old snapshot.
      attendanceSession: { attendanceRecord: { employeeProfile: { user: { organizationId: actor.organizationId } } } },
    };
    const names = (filter.employeeName || '').trim().slice(0, 100).split(/\s+/).filter(Boolean);
    const where = {
      ...base,
      leftAt: { gte: start, lt: end },
      ...(filter.status ? { returnedAt: filter.status === 'RETURNED' ? { not: null } : null } : {}),
      ...(filter.workLocationId ? { workLocationId: filter.workLocationId } : {}),
      ...(names.length ? {
        AND: names.map(part => ({
          attendanceSession: { attendanceRecord: { employeeProfile: {
            OR: [
              { firstName: { contains: part, mode: 'insensitive' as const } },
              { lastName: { contains: part, mode: 'insensitive' as const } },
              { employeeCode: { contains: part, mode: 'insensitive' as const } },
            ],
          } } },
        })),
      } : {}),
    };
    const dayFilter = { ...base, leftAt: { gte: start, lt: end } };
    const [data, total, alertsToday, returnedToday, outsideNow] = await this.prisma.$transaction([
      this.prisma.attendanceLocationAlert.findMany({
        where,
        include: {
          attendanceSession: { select: {
            punchOutAt: true,
            attendanceRecord: { select: { employeeProfile: { select: {
              employeeCode: true, firstName: true, lastName: true,
            } } } },
          } },
        },
        orderBy: { leftAt: 'desc' }, skip: (page - 1) * limit, take: limit,
      }),
      this.prisma.attendanceLocationAlert.count({ where }),
      this.prisma.attendanceLocationAlert.count({ where: dayFilter }),
      this.prisma.attendanceLocationAlert.count({ where: { ...dayFilter, returnedAt: { not: null } } }),
      this.prisma.attendanceLocationAlert.count({ where: {
        ...base, returnedAt: null,
        attendanceSession: { attendanceRecord: { employeeProfile: { user: { organizationId: actor.organizationId } } },
          punchOutAt: null, approvalStatus: { in: ['APPROVED', 'NOT_REQUIRED'] } },
      } }),
    ]);

    // WorkLocation.address is the address entered by the Admin; the alert
    // retains workLocationName as a historical label for API compatibility.
    const locationIds = [...new Set(data.map(alert => alert.workLocationId))];
    const locationAddresses = locationIds.length
      ? await this.prisma.workLocation.findMany({
          where: { id: { in: locationIds } },
          select: { id: true, address: true },
        })
      : [];
    const addressByLocationId = new Map(locationAddresses.map(location => [
      location.id, location.address?.trim() || null,
    ]));

    // Retry historical null names only after an operator configures a provider.
    this.queueMissingExitNames(data);

    return {
      date,
      summary: { alertsToday, currentlyOutside: outsideNow, returnedToday },
      data: data.map(alert => ({
        id: alert.id,
        employeeName: `${alert.attendanceSession.attendanceRecord.employeeProfile.firstName} ${alert.attendanceSession.attendanceRecord.employeeProfile.lastName}`.trim(),
        employeeCode: alert.attendanceSession.attendanceRecord.employeeProfile.employeeCode,
        workLocationId: alert.workLocationId,
        workLocationName: alert.workLocationName,
        workLocationAddress: addressByLocationId.get(alert.workLocationId) ?? null,
        workLocationLatitude: alert.workLocationLatitude,
        workLocationLongitude: alert.workLocationLongitude,
        exitLocationName: alert.exitLocationName,
        exitLatitude: alert.exitLatitude,
        exitLongitude: alert.exitLongitude,
        leftAt: alert.leftAt,
        returnedAt: alert.returnedAt,
        status: alert.returnedAt ? 'RETURNED' : 'OUTSIDE',
        sessionActive: !alert.attendanceSession.punchOutAt,
      })),
      pagination: { total, page, limit, totalPages: Math.ceil(total / limit) },
    };
  }
}
