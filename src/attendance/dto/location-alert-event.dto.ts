import { IsNumber, IsUUID, Max, Min } from 'class-validator';

/** The browser submits a location fix only on a confirmed geofence transition. */
export class LocationAlertEventDto {
  @IsUUID()
  sessionId!: string;

  @IsUUID()
  workLocationId!: string;

  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Min(-90)
  @Max(90)
  latitude!: number;

  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Min(-180)
  @Max(180)
  longitude!: number;

  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Min(0)
  @Max(10000)
  accuracy!: number;
}
