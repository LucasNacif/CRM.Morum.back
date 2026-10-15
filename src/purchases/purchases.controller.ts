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
  IsDate,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { BusinessId } from '../common/business.js';
import { CurrentUser, type AuthUser } from '../common/decorators.js';
import { paginated, PaginationDto } from '../common/pagination.dto.js';
import { MovementType, Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { ProductsService } from '../products/products.service.js';
import { StockService } from '../stock/stock.service.js';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() || undefined : value);

/** Reposición de una prenda que ya existe. */
export class PurchaseItemDto {
  @IsUUID()
  variantId: string;

  @IsInt()
  @Min(1)
  quantity: number;

  /** Lo pagado al proveedor por unidad, sin envío ni packaging. */
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  unitCost: number;

  /** Precio de venta con el que queda la prenda. */
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  price: number;
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

  @IsOptional()
  @Transform(trim)
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

/** Producto que entra por primera vez con esta compra. */
export class NewProductDto {
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name: string;

  @IsOptional()
  @Transform(trim)
  @IsUUID()
  categoryId?: string;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(200)
  @ValidateNested({ each: true })
  @Type(() => NewVariantDto)
  variants: NewVariantDto[];
}

/** Gasto sin stock: bolsas, percheros, etc. */
export class ExpenseDto {
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  description: string;

  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.01)
  amount: number;
}

export class CreatePurchaseDto {
  @IsOptional()
  @Type(() => Date)
  @IsDate()
  date?: Date;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(120)
  supplier?: string;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(500)
  note?: string;

  /** Total del envío: se reparte en partes iguales entre las prendas. */
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  shippingCost?: number;

  /** Total del packaging: se reparte en partes iguales entre las prendas. */
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  packagingCost?: number;

  /** Ganancia general usada para sugerir precios. Solo se guarda como referencia. */
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(10000)
  markupPercent?: number;

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

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => ExpenseDto)
  expenses?: ExpenseDto[];
}

const purchaseInclude = {
  items: { include: { variant: { include: { product: { select: { id: true, name: true } } } } } },
  expenses: true,
} satisfies Prisma.PurchaseInclude;

const round2 = (value: Prisma.Decimal) => value.toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);

@Injectable()
export class PurchasesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly stock: StockService,
    private readonly products: ProductsService,
  ) {}

  /**
   * Registra la compra completa en una transacción: repone prendas, da de alta las nuevas y
   * reparte envío y packaging entre todas las unidades. El costo de cada prenda pasa a ser el
   * de esta compra con esos gastos incluidos.
   */
  create(businessId: string, dto: CreatePurchaseDto, userId: string) {
    const items = dto.items ?? [];
    const newProducts = dto.newProducts ?? [];
    const expenses = dto.expenses ?? [];
    const units =
      items.reduce((sum, item) => sum + item.quantity, 0) +
      newProducts.reduce((sum, product) => sum + product.variants.reduce((acc, v) => acc + v.quantity, 0), 0);
    const shipping = new Prisma.Decimal(dto.shippingCost ?? 0);
    const packaging = new Prisma.Decimal(dto.packagingCost ?? 0);

    if (units === 0 && expenses.length === 0) throw new BadRequestException('La compra está vacía');
    if (units === 0 && shipping.plus(packaging).greaterThan(0)) {
      throw new BadRequestException('El envío y el packaging se reparten entre prendas: la compra no tiene ninguna');
    }
    const variantIds = items.map((item) => item.variantId);
    if (new Set(variantIds).size !== variantIds.length) throw new BadRequestException('Hay una prenda repetida en la compra');

    const extraPerUnit = units > 0 ? shipping.plus(packaging).dividedBy(units) : new Prisma.Decimal(0);
    const landed = (unitCost: number) => round2(extraPerUnit.plus(unitCost));

    return this.prisma.$transaction(async (tx) => {
      const owned = await tx.variant.count({ where: { id: { in: variantIds }, product: { businessId } } });
      if (owned !== variantIds.length) throw new NotFoundException('Una de las prendas no existe');

      const lines = items.map(({ variantId, quantity, unitCost, price }) => ({ variantId, quantity, unitCost, price, landedCost: landed(unitCost) }));
      for (const { name, categoryId, variants } of newProducts) {
        const created = await this.products.createInTransaction(
          tx,
          businessId,
          { name, categoryId },
          variants.map(({ size, color, barcode, unitCost, price }) => ({ size, color, barcode, cost: landed(unitCost).toNumber(), price })),
          userId,
        );
        created.forEach((variant, index) => {
          const { quantity, unitCost, price } = variants[index];
          lines.push({ variantId: variant.id, quantity, unitCost, price, landedCost: landed(unitCost) });
        });
      }

      const productsTotal = lines.reduce((sum, line) => sum.plus(new Prisma.Decimal(line.unitCost).times(line.quantity)), new Prisma.Decimal(0));
      const expensesTotal = expenses.reduce((sum, expense) => sum.plus(expense.amount), new Prisma.Decimal(0));

      const { lastPurchaseNumber: number } = await tx.business.update({
        where: { id: businessId },
        data: { lastPurchaseNumber: { increment: 1 } },
        select: { lastPurchaseNumber: true },
      });
      const purchase = await tx.purchase.create({
        data: {
          businessId,
          number,
          date: dto.date,
          supplier: dto.supplier,
          note: dto.note,
          shippingCost: shipping,
          packagingCost: packaging,
          markupPercent: dto.markupPercent ?? 0,
          productsTotal,
          expensesTotal,
          total: productsTotal.plus(shipping).plus(packaging).plus(expensesTotal),
          userId,
          items: {
            create: lines.map(({ variantId, quantity, unitCost, landedCost, price }) => ({ variantId, quantity, unitCost, landedCost, price })),
          },
          expenses: { create: expenses },
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
        await tx.variant.update({ where: { id: line.variantId }, data: { cost: line.landedCost, price: line.price } });
      }
      return tx.purchase.findUniqueOrThrow({ where: { id: purchase.id }, include: purchaseInclude });
    });
  }

  async list(businessId: string, q: PaginationDto) {
    const where = { businessId };
    const [purchases, total] = await Promise.all([
      this.prisma.purchase.findMany({
        where,
        orderBy: [{ date: 'desc' }, { number: 'desc' }],
        skip: q.skip,
        take: q.pageSize,
        include: { items: { select: { quantity: true } }, _count: { select: { expenses: true } } },
      }),
      this.prisma.purchase.count({ where }),
    ]);
    const items = purchases.map(({ items: lines, ...purchase }) => ({
      ...purchase,
      units: lines.reduce((sum, line) => sum + line.quantity, 0),
    }));
    return paginated(items, total, q);
  }

  async get(businessId: string, id: string) {
    const purchase = await this.prisma.purchase.findFirst({ where: { id, businessId }, include: purchaseInclude });
    if (!purchase) throw new NotFoundException('No se encontró la compra');
    return purchase;
  }
}

@Controller('purchases')
export class PurchasesController {
  constructor(private readonly purchases: PurchasesService) {}

  @Get()
  list(@BusinessId() businessId: string, @Query() q: PaginationDto) {
    return this.purchases.list(businessId, q);
  }

  @Get(':id')
  get(@BusinessId() businessId: string, @Param('id', ParseUUIDPipe) id: string) {
    return this.purchases.get(businessId, id);
  }

  @Post()
  create(@BusinessId() businessId: string, @Body() dto: CreatePurchaseDto, @CurrentUser() user: AuthUser) {
    return this.purchases.create(businessId, dto, user.id);
  }
}
