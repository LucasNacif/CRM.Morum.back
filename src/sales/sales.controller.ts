import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Get,
  HttpCode,
  Injectable,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsDate,
  IsEnum,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { CurrentUser, type AuthUser } from '../common/decorators.js';
import { paginated, PaginationDto } from '../common/pagination.dto.js';
import { MovementType, PaymentMethod, Prisma, SaleStatus } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { StockService } from '../stock/stock.service.js';

export class SaleItemDto {
  @IsUUID()
  variantId: string;

  @IsInt()
  @Min(1)
  quantity: number;

  /** Si no se envía se usa el precio actual de la variante. */
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  unitPrice?: number;
}

export class CreateSaleDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(200)
  @ValidateNested({ each: true })
  @Type(() => SaleItemDto)
  items: SaleItemDto[];

  /** Descuento en pesos sobre el subtotal. */
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  discount?: number;

  @IsEnum(PaymentMethod)
  paymentMethod: PaymentMethod;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  customerName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}

export class SalesQueryDto extends PaginationDto {
  @IsOptional()
  @Type(() => Date)
  @IsDate()
  from?: Date;

  @IsOptional()
  @Type(() => Date)
  @IsDate()
  to?: Date;
}

const saleInclude = {
  items: {
    include: {
      variant: {
        select: { sku: true, size: true, color: true, product: { select: { id: true, name: true } } },
      },
    },
  },
} satisfies Prisma.SaleInclude;

@Injectable()
export class SalesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly stock: StockService,
  ) {}

  create(dto: CreateSaleDto, userId: string) {
    const variantIds = dto.items.map((item) => item.variantId);
    if (new Set(variantIds).size !== variantIds.length) {
      throw new BadRequestException('Hay una variante repetida en la venta');
    }

    return this.prisma.$transaction(async (tx) => {
      const variants = await tx.variant.findMany({ where: { id: { in: variantIds } } });
      const byId = new Map(variants.map((variant) => [variant.id, variant]));

      const items = dto.items.map((item) => {
        const variant = byId.get(item.variantId);
        if (!variant) throw new NotFoundException('Una de las prendas ya no existe');
        return {
          variantId: variant.id,
          quantity: item.quantity,
          unitPrice: new Prisma.Decimal(item.unitPrice ?? variant.price),
          unitCost: variant.cost,
        };
      });
      const subtotal = items.reduce(
        (sum, item) => sum.plus(item.unitPrice.times(item.quantity)),
        new Prisma.Decimal(0),
      );
      const discount = new Prisma.Decimal(dto.discount ?? 0);
      if (discount.greaterThan(subtotal)) {
        throw new BadRequestException('El descuento no puede superar el subtotal');
      }

      const sale = await tx.sale.create({
        data: {
          subtotal,
          discount,
          total: subtotal.minus(discount),
          paymentMethod: dto.paymentMethod,
          customerName: dto.customerName,
          note: dto.note,
          userId,
          items: { create: items },
        },
      });
      for (const item of items) {
        await this.stock.applyMovement(tx, {
          variantId: item.variantId,
          quantity: -item.quantity,
          type: MovementType.SALE,
          userId,
          saleId: sale.id,
          note: `Venta #${sale.number}`,
        });
      }
      return tx.sale.findUniqueOrThrow({ where: { id: sale.id }, include: saleInclude });
    });
  }

  /** Anula la venta y devuelve las prendas al stock. La venta queda en el historial. */
  cancel(id: string, userId: string) {
    return this.prisma.$transaction(async (tx) => {
      // El updateMany condicional evita anular dos veces si llegan dos pedidos a la vez.
      const { count } = await tx.sale.updateMany({
        where: { id, status: SaleStatus.COMPLETED },
        data: { status: SaleStatus.CANCELLED, cancelledAt: new Date() },
      });
      const sale = await tx.sale.findUnique({ where: { id }, include: saleInclude });
      if (!sale) throw new NotFoundException('No se encontró la venta');
      if (count === 0) throw new ConflictException('La venta ya estaba anulada');

      for (const item of sale.items) {
        await this.stock.applyMovement(tx, {
          variantId: item.variantId,
          quantity: item.quantity,
          type: MovementType.SALE_CANCEL,
          userId,
          saleId: sale.id,
          note: `Anulación de venta #${sale.number}`,
        });
      }
      return sale;
    });
  }

  async list(q: SalesQueryDto) {
    const where: Prisma.SaleWhereInput = {
      date: q.from || q.to ? { gte: q.from, lte: q.to } : undefined,
    };
    const [items, total] = await Promise.all([
      this.prisma.sale.findMany({
        where,
        orderBy: { date: 'desc' },
        skip: q.skip,
        take: q.pageSize,
        include: { _count: { select: { items: true } } },
      }),
      this.prisma.sale.count({ where }),
    ]);
    return paginated(items, total, q);
  }

  async get(id: string) {
    const sale = await this.prisma.sale.findUnique({ where: { id }, include: saleInclude });
    if (!sale) throw new NotFoundException('No se encontró la venta');
    return sale;
  }
}

@Controller('sales')
export class SalesController {
  constructor(private readonly sales: SalesService) {}

  @Get()
  list(@Query() q: SalesQueryDto) {
    return this.sales.list(q);
  }

  @Get(':id')
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.sales.get(id);
  }

  @Post()
  create(@Body() dto: CreateSaleDto, @CurrentUser() user: AuthUser) {
    return this.sales.create(dto, user.id);
  }

  @HttpCode(200)
  @Post(':id/cancel')
  cancel(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthUser) {
    return this.sales.cancel(id, user.id);
  }
}
