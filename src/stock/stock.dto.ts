import { IsIn, IsInt, IsNumber, IsOptional, IsString, IsUUID, MaxLength, Min } from 'class-validator';

export class AdjustStockDto {
  @IsUUID()
  variantId: string;

  /** `delta` suma o resta; `set` fija el stock al valor contado. */
  @IsIn(['delta', 'set'])
  mode: 'delta' | 'set';

  @IsInt()
  quantity: number;

  /** Costo unitario de la reposición: pasa a ser el costo de la prenda. */
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  cost?: number;

  /** Nuevo precio de venta. Si no se manda, no cambia. */
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  price?: number;

  @IsOptional()
  @IsString()
  @MaxLength(300)
  note?: string;
}
