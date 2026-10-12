import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  IsUrl,
  IsUUID,
  Matches,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { PaginationDto } from '../common/pagination.dto.js';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);
const trimUpper = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim().toUpperCase() : value;
// Los formularios mandan '' cuando el campo queda vacío: se trata como "no enviado".
const emptyToUndefined = ({ value }: { value: unknown }) =>
  typeof value === 'string' && value.trim() === '' ? undefined : trim({ value });
const toBoolean = ({ value }: { value: unknown }) => value === true || value === 'true';

const CODE_PATTERN = /^[A-Za-z0-9._-]{3,40}$/;
const CODE_MESSAGE = 'Solo letras, números, punto, guion y guion bajo (3 a 40 caracteres)';

export class CreateVariantDto {
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(20)
  size: string;

  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(40)
  color: string;

  /** Si no se envía se genera a partir de producto, color y talle. */
  @IsOptional()
  @Transform(({ value }) => emptyToUndefined({ value: trimUpper({ value }) }))
  @Matches(CODE_PATTERN, { message: `SKU inválido. ${CODE_MESSAGE}` })
  sku?: string;

  /** Si no se envía se asigna el siguiente código interno. Sirve para cargar un código de fábrica. */
  @IsOptional()
  @Transform(emptyToUndefined)
  @Matches(CODE_PATTERN, { message: `Código de barras inválido. ${CODE_MESSAGE}` })
  barcode?: string;

  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  cost: number;

  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  price: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  minStock?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  initialStock?: number;
}

export class UpdateVariantDto {
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(20)
  size?: string;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(40)
  color?: string;

  @IsOptional()
  @Transform(trimUpper)
  @Matches(CODE_PATTERN, { message: `SKU inválido. ${CODE_MESSAGE}` })
  sku?: string;

  @IsOptional()
  @Transform(trim)
  @Matches(CODE_PATTERN, { message: `Código de barras inválido. ${CODE_MESSAGE}` })
  barcode?: string;

  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  cost?: number;

  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  price?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  minStock?: number;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

export class CreateProductDto {
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name: string;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(2000)
  description?: string;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(60)
  brand?: string;

  @IsOptional()
  @Transform(emptyToUndefined)
  @IsUrl({ require_protocol: true })
  imageUrl?: string;

  @IsOptional()
  @Transform(emptyToUndefined)
  @IsUUID()
  categoryId?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(200)
  @ValidateNested({ each: true })
  @Type(() => CreateVariantDto)
  variants?: CreateVariantDto[];
}

export class UpdateProductDto {
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name?: string;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(2000)
  description?: string;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(60)
  brand?: string;

  /** `null` quita la imagen. */
  @IsOptional()
  @Transform(({ value }) => (value === '' ? null : value))
  @IsUrl({ require_protocol: true })
  imageUrl?: string | null;

  /** `null` deja el producto sin categoría. */
  @IsOptional()
  @Transform(({ value }) => (value === '' ? null : value))
  @IsUUID()
  categoryId?: string | null;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @IsOptional()
  @IsBoolean()
  isPublished?: boolean;
}

export class ProductsQueryDto extends PaginationDto {
  @IsOptional()
  @Transform(trim)
  @IsString()
  search?: string;

  @IsOptional()
  @IsUUID()
  categoryId?: string;

  @IsOptional()
  @Transform(toBoolean)
  @IsBoolean()
  includeInactive?: boolean;
}

export class VariantsQueryDto extends PaginationDto {
  @IsOptional()
  @Transform(trim)
  @IsString()
  search?: string;

  @IsOptional()
  @Transform(toBoolean)
  @IsBoolean()
  lowStock?: boolean;
}
