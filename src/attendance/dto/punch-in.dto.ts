import { IsNumber, IsOptional, Max, Min, IsString, MaxLength } from 'class-validator';

export class PunchInDto {
  @IsNumber()
  @Min(-90)
  @Max(90)
  latitude: number;

  @IsNumber()
  @Min(-180)
  @Max(180)
  longitude: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  accuracy?: number;

  @IsOptional()
@IsString()
@MaxLength(500)
lateReason?: string;
}