import { Type } from 'class-transformer';
import { IsDate, IsEnum, IsIn, IsInt, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';
import { PaginationDto } from '../common/pagination.dto.js';
import { MovementType } from '../generated/prisma/client.js';

export class AdjustStockDto {
  @IsUUID()
  variantId: string;

  /** `delta` suma o resta; `set` fija el stock al valor contado. */
  @IsIn(['delta', 'set'])
  mode: 'delta' | 'set';

  @IsInt()
  quantity: number;

  @IsOptional()
  @IsString()
  @MaxLength(300)
  note?: string;
}

export class MovementsQueryDto extends PaginationDto {
  @IsOptional()
  @IsUUID()
  variantId?: string;

  @IsOptional()
  @IsEnum(MovementType)
  type?: MovementType;

  @IsOptional()
  @Type(() => Date)
  @IsDate()
  from?: Date;

  @IsOptional()
  @Type(() => Date)
  @IsDate()
  to?: Date;
}
