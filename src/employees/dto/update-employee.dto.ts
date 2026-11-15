import {
  IsEmail,
  IsOptional,
  IsString,
  IsNotEmpty,
  IsUUID,
  IsDateString,
  MaxLength,
  IsArray, ArrayMinSize, ArrayMaxSize, ArrayUnique,
} from 'class-validator';

export class UpdateEmployeeDto {
  @IsOptional()
  @IsEmail()
  email?: string;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  firstName?: string;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  lastName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  phone?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  designation?: string;

  @IsOptional()
  @IsUUID()
  departmentId?: string;

  @IsOptional()
  @IsDateString()
  joiningDate?: string;

  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(24)
  @ArrayUnique()
  @IsUUID('4', { each: true })
  shiftIds?: string[];
}