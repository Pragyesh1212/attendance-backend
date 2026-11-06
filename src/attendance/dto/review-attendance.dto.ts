import {
    IsIn,
    IsOptional,
    IsString,
    MaxLength,
    ValidateIf,
} from 'class-validator';

export class ReviewAttendanceDto {
    @IsIn(['APPROVE', 'REJECT'])
    action: 'APPROVE' | 'REJECT';

    @ValidateIf((o) => o.action === 'REJECT')
    @IsString()
    @MaxLength(500)
    rejectionReason?: string;
}