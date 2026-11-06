import { IsUUID } from 'class-validator';

export class AssignEmployeeShiftDto {
  @IsUUID()
  shiftId: string;
}