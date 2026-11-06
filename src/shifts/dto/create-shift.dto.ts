import {
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  Matches,
} from 'class-validator';

export class CreateShiftDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  name: string;

  @IsString()
  @Matches(/^([01]\d|2[0-3]):[0-5]\d$/, {
    message: 'startTime must be in HH:mm format',
  })
  startTime: string;

  @IsString()
  @Matches(/^([01]\d|2[0-3]):[0-5]\d$/, {
    message: 'endTime must be in HH:mm format',
  })
  endTime: string;

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
}