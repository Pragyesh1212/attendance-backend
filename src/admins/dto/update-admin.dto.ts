
import {
  IsEmail,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
  IsNotEmpty,
  IsUUID,
} from 'class-validator';

export class UpdateAdminDto {
  @IsOptional()
  @IsEmail()
  @MaxLength(255)
  email?: string;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MinLength(2)
  @MaxLength(100)
  firstName?: string;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MinLength(2)
  @MaxLength(100)
  lastName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  phone?: string;

  // Kept for compatibility with existing profile data/API.
  @IsOptional()
  @IsString()
  @MaxLength(100)
  designation?: string;

  // Allows Super Admin to transfer an admin to another organization.
  @IsOptional()
  @IsUUID()
  organizationId?: string;
}
