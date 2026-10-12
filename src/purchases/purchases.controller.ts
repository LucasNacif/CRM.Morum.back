import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Injectable,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  Matches,
  IsDate,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { CurrentUser, type AuthUser } from '../common/decorators.js';
import { paginated, PaginationDto } from '../common/pagination.dto.js';
import { MovementType, Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { ProductsService } from '../products/products.service.js';
import { StockService } from '../stock/stock.service.js';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);
const emptyToUndefined = ({ value }: { value: unknown }) =>
  typeof value === 'string' && value.trim() === '' ? undefined : trim({ value });

/** Reposición de una prenda que ya existe. */
export class PurchaseItemDto {
  @IsUUID()
  variantId: string;

  @IsInt()
  @Min(1)
  quantity: number;

  /** Lo que se pagó por unidad. Pasa a ser el costo de la prenda. */
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  unitCost: number;

  /** Nuevo precio de venta. Si no se envía, el precio no cambia. */
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  price?: number;
}

export class NewVariantDto {
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

  /** Código de fábrica. Si no se envía se asigna uno interno. */
  @IsOptional()
  @Transform(emptyToUndefined)
  @Matches(/^\d{4,20}$/, { message: 'Código de barras inválido. Solo números (4 a 20 dígitos)' })
  barcode?: string;

  @IsInt()
  @Min(1)
  quantity: number;

  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  unitCost: number;

  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  price: number;
}

/** Producto que entra por primera vez: se da de alta junto con la compra. */
export class NewProductDto {
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name: string;

  @IsOptional()
  @Transform(emptyToUndefined)
  @IsUUID()
  categoryId?: string;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(200)
  @ValidateNested({ each: true })
  @Type(() => NewVariantDto)
  variants: NewVariantDto[];
}

export class CreatePurchaseDto {
  @IsOptional()
  @Type(() => Date)
  @IsDate()
  date?: Date;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(300)
  @ValidateNested({ each: true })
  @Type(() => PurchaseItemDto)
  items?: PurchaseItemDto[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => NewProductDto)
  newProducts?: NewProductDto[];
}

const purchaseInclude = {
  items: {
    include: {
      variant: { include: { product: { select: { id: true, name: true } } } },
    },
  },
} satisfies Prisma.PurchaseInclude;

@Injectable()
export class PurchasesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly stock: StockService,
    private readonly products: ProductsService,
  ) {}

  /**
   * Único camino por el que entra mercadería: repone prendas existentes y da de alta las nuevas,
   * todo en una transacción. Si algo falla no queda ni el producto ni el stock a medias.
   */
  create(dto: CreatePurchaseDto, userId: string) {
    const items = dto.items ?? [];
    const newProducts = dto.newProducts ?? [];
    if (items.length === 0 && newProducts.length === 0) {
      throw new BadRequestException('La compra no tiene prendas');
    }
    const variantIds = items.map((item) => item.variantId);
    if (new Set(variantIds).size !== variantIds.length) {
      throw new BadRequestException('Hay una prenda repetida en la compra');
    }

    return this.prisma.$transaction(async (tx) => {
      const lines: { variantId: string; quantity: number; unitCost: number; price?: number }[] = items.map(
        ({ variantId, quantity, unitCost, price }) => ({ variantId, quantity, unitCost, price }),
      );
      for (const { variants, name, categoryId } of newProducts) {
        const created = await this.products.createInTransaction(
          tx,
          { name, categoryId },
          variants.map(({ size, color, barcode, unitCost, price }) => ({ size, color, barcode, cost: unitCost, price })),
          userId,
        );
        created.forEach((variant, index) => {
          const { quantity, unitCost } = variants[index];
          lines.push({ variantId: variant.id, quantity, unitCost });
        });
      }

      const total = lines.reduce(
        (sum, line) => sum.plus(new Prisma.Decimal(line.unitCost).times(line.quantity)),
        new Prisma.Decimal(0),
      );
      const purchase = await tx.purchase.create({
        data: {
          date: dto.date,
          note: dto.note,
          total,
          userId,
          items: { create: lines.map(({ variantId, quantity, unitCost }) => ({ variantId, quantity, unitCost })) },
        },
      });
      for (const line of lines) {
        await this.stock.applyMovement(tx, {
          variantId: line.variantId,
          quantity: line.quantity,
          type: MovementType.PURCHASE,
          userId,
          purchaseId: purchase.id,
          note: `Compra #${purchase.number}`,
        });
        await tx.variant.update({
          where: { id: line.variantId },
          data: { cost: line.unitCost, price: line.price },
        });
      }
      return tx.purchase.findUniqueOrThrow({ where: { id: purchase.id }, include: purchaseInclude });
    });
  }

  async list(q: PaginationDto) {
    const [items, total] = await Promise.all([
      this.prisma.purchase.findMany({
        orderBy: { date: 'desc' },
        skip: q.skip,
        take: q.pageSize,
        include: { _count: { select: { items: true } } },
      }),
      this.prisma.purchase.count(),
    ]);
    return paginated(items, total, q);
  }

  async get(id: string) {
    const purchase = await this.prisma.purchase.findUnique({ where: { id }, include: purchaseInclude });
    if (!purchase) throw new NotFoundException('No se encontró la compra');
    return purchase;
  }
}

@Controller('purchases')
export class PurchasesController {
  constructor(private readonly purchases: PurchasesService) {}

  @Get()
  list(@Query() q: PaginationDto) {
    return this.purchases.list(q);
  }

  @Get(':id')
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.purchases.get(id);
  }

  @Post()
  create(@Body() dto: CreatePurchaseDto, @CurrentUser() user: AuthUser) {
    return this.purchases.create(dto, user.id);
  }
}
