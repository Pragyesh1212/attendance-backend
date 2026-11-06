
import {
  IsEnum,
  IsLatitude,
  IsLongitude,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

import { WorkLocationType } from '../../generated/prisma/client';

export class CreateWorkLocationDto {
  @IsString()
  @MinLength(2)
  @MaxLength(150)
  name: string;

  @IsEnum(WorkLocationType)
  type: WorkLocationType;

  @IsOptional()
  @IsString()
  address?: string;

  @IsLatitude()
  latitude: number;

  @IsLongitude()
  longitude: number;

  @IsOptional()
  @IsNumber()
  @Min(10)
  @Max(5000)
  radiusMeters?: number;
}
