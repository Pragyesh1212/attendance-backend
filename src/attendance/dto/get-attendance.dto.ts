import {
  IsDateString,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  IsUUID,
  Max,
  Min,
} from 'class-validator';

import { Type } from 'class-transformer';
import { AttendanceStatus } from '../../generated/prisma/client';

export class GetAttendanceDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page: number = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit: number = 10;

  @IsOptional()
  @IsDateString()
  startDate?: string;

  @IsOptional()
  @IsDateString()
  endDate?: string;

  @IsOptional()
  @IsEnum(AttendanceStatus)
  status?: AttendanceStatus;

  // Admin-only attendance search; employee attendance history ignores this filter.
  @IsOptional()
  @IsString()
  @MaxLength(100)
  employeeName?: string;

  @IsOptional()
  @IsUUID()
  employeeProfileId?: string;
}