import {
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  Matches,
} from 'class-validator';

import { ShiftStatus } from '../../generated/prisma/client';

export class UpdateShiftDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  name?: string;

  @IsOptional()
  @IsString()
  @Matches(/^([01]\d|2[0-3]):[0-5]\d$/)
  startTime?: string;

  @IsOptional()
  @IsString()
  @Matches(/^([01]\d|2[0-3]):[0-5]\d$/)
  endTime?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(1440)
  gracePeriodMinutes?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(1440)
  lateReasonAfterMinutes?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(1440)
  approvalRequiredAfterMinutes?: number;

  @IsOptional()
  @IsEnum(ShiftStatus)
  status?: ShiftStatus;
}