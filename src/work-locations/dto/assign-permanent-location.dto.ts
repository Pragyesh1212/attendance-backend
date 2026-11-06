
import { IsUUID } from 'class-validator';

export class AssignPermanentLocationDto {
  @IsUUID()
  workLocationId: string;
}
