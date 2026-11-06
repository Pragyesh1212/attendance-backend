
import {
  IsDateString,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';

export class CreateAttendanceCorrectionDto {
  @IsString()
  attendanceSessionId: string;

  @IsDateString()
  requestedPunchInAt: string;

  @IsOptional()
  @IsDateString()
  requestedPunchOutAt?: string;

  @IsString()
  @MaxLength(500)
  reason: string;
}
