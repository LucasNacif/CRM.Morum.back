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
import { Transform, Type } from 'class-transformer';
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
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { BusinessId } from '../common/business.js';
import { CurrentUser, type AuthUser } from '../common/decorators.js';
import { paginated, PaginationDto } from '../common/pagination.dto.js';
import { Delivery, MovementType, PaymentMethod, Prisma, SaleStatus } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { StockService } from '../stock/stock.service.js';

const DAY = 24 * 60 * 60 * 1000;
const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() || undefined : value);

export class SaleItemDto {
  @IsUUID()
  variantId: string;

  @IsInt()
  @Min(1)
  quantity: number;

  /** Precio especial para esta prenda. Si no se envía se usa el precio actual. */
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

  /** Lo que paga ahora. Si no se envía, paga el total. Si es menor, queda saldo por cobrar. */
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  paidAmount?: number;

  /** Días para cobrar el saldo. Obligatorio cuando paga una parte. */
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(365)
  dueInDays?: number;

  /** Si paga una parte: se la lleva (DELIVERED) o queda apartada (RESERVED). */
  @IsOptional()
  @IsEnum(Delivery)
  delivery?: Delivery;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(100)
  customerName?: string;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(40)
  customerPhone?: string;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(500)
  note?: string;
}

export class PaymentDto {
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.01)
  amount: number;

  @IsEnum(PaymentMethod)
  method: PaymentMethod;
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
        select: { barcode: true, size: true, color: true, product: { select: { id: true, name: true } } },
      },
    },
  },
  payments: { orderBy: { createdAt: 'asc' } },
} satisfies Prisma.SaleInclude;

type DueStatus = 'overdue' | 'soon' | 'ok';

@Injectable()
export class SalesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly stock: StockService,
  ) {}

  create(businessId: string, dto: CreateSaleDto, userId: string) {
    const variantIds = dto.items.map((item) => item.variantId);
    if (new Set(variantIds).size !== variantIds.length) {
      throw new BadRequestException('Hay una prenda repetida en la venta');
    }

    return this.prisma.$transaction(async (tx) => {
      const variants = await tx.variant.findMany({ where: { id: { in: variantIds }, product: { businessId } } });
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
      const total = subtotal.minus(discount);
      const paid = dto.paidAmount === undefined ? total : new Prisma.Decimal(dto.paidAmount);
      if (paid.greaterThan(total)) throw new BadRequestException('Lo que paga no puede superar el total');

      const partial = paid.lessThan(total);
      if (partial && !dto.customerName) throw new BadRequestException('Si queda saldo, cargá el nombre del cliente');
      if (partial && !dto.dueInDays) throw new BadRequestException('Si queda saldo, indicá en cuántos días lo paga');

      // La fila del negocio queda bloqueada hasta el final: dos ventas no pueden tomar el mismo número.
      const { lastSaleNumber: number } = await tx.business.update({
        where: { id: businessId },
        data: { lastSaleNumber: { increment: 1 } },
        select: { lastSaleNumber: true },
      });

      const sale = await tx.sale.create({
        data: {
          businessId,
          number,
          subtotal,
          discount,
          total,
          paidAmount: paid,
          dueDate: partial ? new Date(Date.now() + dto.dueInDays! * DAY) : null,
          delivery: partial ? (dto.delivery ?? Delivery.DELIVERED) : Delivery.DELIVERED,
          paymentMethod: dto.paymentMethod,
          customerName: dto.customerName,
          customerPhone: dto.customerPhone,
          note: dto.note,
          userId,
          items: { create: items },
          payments: paid.greaterThan(0) ? { create: { amount: paid, method: dto.paymentMethod, userId } } : undefined,
        },
      });
      // Una prenda reservada también sale del stock: no se puede vender a otro.
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

  /** Registra un pago del saldo. No permite cobrar más de lo que se debe. */
  addPayment(businessId: string, id: string, dto: PaymentDto, userId: string) {
    return this.prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<{ id: string }[]>(
        Prisma.sql`SELECT "id" FROM "Sale" WHERE "id" = ${id} AND "businessId" = ${businessId} FOR UPDATE`,
      );
      if (rows.length === 0) throw new NotFoundException('No se encontró la venta');
      const sale = await tx.sale.findUniqueOrThrow({ where: { id } });
      if (sale.status === SaleStatus.CANCELLED) throw new ConflictException('La venta está anulada');
      const balance = sale.total.minus(sale.paidAmount);
      if (balance.lessThanOrEqualTo(0)) throw new ConflictException('La venta ya está paga');
      if (balance.lessThan(dto.amount)) {
        throw new BadRequestException(`El saldo es de $${balance.toFixed(2)}: no se puede cobrar más`);
      }
      await tx.payment.create({ data: { saleId: id, amount: dto.amount, method: dto.method, userId } });
      await tx.sale.update({ where: { id }, data: { paidAmount: { increment: dto.amount } } });
      return tx.sale.findUniqueOrThrow({ where: { id }, include: saleInclude });
    });
  }

  /** Entrega una prenda que había quedado reservada. */
  async deliver(businessId: string, id: string) {
    const { count } = await this.prisma.sale.updateMany({
      where: { id, businessId, status: SaleStatus.COMPLETED, delivery: Delivery.RESERVED },
      data: { delivery: Delivery.DELIVERED },
    });
    if (count === 0) throw new ConflictException('La venta no tiene prendas reservadas para entregar');
    return this.get(businessId, id);
  }

  /** Anula la venta y devuelve las prendas al stock. Los pagos recibidos quedan registrados. */
  cancel(businessId: string, id: string, userId: string) {
    return this.prisma.$transaction(async (tx) => {
      // El updateMany condicional evita anular dos veces si llegan dos pedidos a la vez.
      const { count } = await tx.sale.updateMany({
        where: { id, businessId, status: SaleStatus.COMPLETED },
        data: { status: SaleStatus.CANCELLED, cancelledAt: new Date() },
      });
      const sale = await tx.sale.findFirst({ where: { id, businessId }, include: saleInclude });
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

  async list(businessId: string, q: SalesQueryDto) {
    const where: Prisma.SaleWhereInput = {
      businessId,
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

  /** Ventas con saldo por cobrar, de la que vence primero a la última. */
  async pending(businessId: string) {
    // Comparar dos columnas entre sí no se puede expresar con el where de Prisma.
    const rows = await this.prisma.$queryRaw<{ id: string }[]>(Prisma.sql`
      SELECT "id" FROM "Sale"
      WHERE "businessId" = ${businessId} AND "status" = 'COMPLETED' AND "paidAmount" < "total"
      ORDER BY "dueDate" ASC NULLS LAST, "date" ASC`);
    const ids = rows.map((row) => row.id);
    const [sales, settings] = await Promise.all([
      this.prisma.sale.findMany({ where: { id: { in: ids } }, include: { _count: { select: { items: true } } } }),
      this.prisma.settings.findUnique({ where: { businessId } }),
    ]);
    const alertDays = settings?.dueAlertDays ?? 3;
    const byId = new Map(sales.map((sale) => [sale.id, sale]));
    const now = Date.now();

    const items = ids.flatMap((id) => {
      const sale = byId.get(id);
      if (!sale) return [];
      const daysLeft = sale.dueDate ? Math.ceil((sale.dueDate.getTime() - now) / DAY) : null;
      const dueStatus: DueStatus =
        daysLeft === null ? 'ok' : sale.dueDate!.getTime() < now ? 'overdue' : daysLeft <= alertDays ? 'soon' : 'ok';
      return [{ ...sale, balance: sale.total.minus(sale.paidAmount), daysLeft, dueStatus }];
    });
    return {
      items,
      overdue: items.filter((item) => item.dueStatus === 'overdue').length,
      soon: items.filter((item) => item.dueStatus === 'soon').length,
      total: items.reduce((sum, item) => sum.plus(item.balance), new Prisma.Decimal(0)),
    };
  }

  async get(businessId: string, id: string) {
    const sale = await this.prisma.sale.findFirst({ where: { id, businessId }, include: saleInclude });
    if (!sale) throw new NotFoundException('No se encontró la venta');
    return sale;
  }
}

@Controller('sales')
export class SalesController {
  constructor(private readonly sales: SalesService) {}

  @Get()
  list(@BusinessId() businessId: string, @Query() q: SalesQueryDto) {
    return this.sales.list(businessId, q);
  }

  @Get('pending')
  pending(@BusinessId() businessId: string) {
    return this.sales.pending(businessId);
  }

  @Get(':id')
  get(@BusinessId() businessId: string, @Param('id', ParseUUIDPipe) id: string) {
    return this.sales.get(businessId, id);
  }

  @Post()
  create(@BusinessId() businessId: string, @Body() dto: CreateSaleDto, @CurrentUser() user: AuthUser) {
    return this.sales.create(businessId, dto, user.id);
  }

  @HttpCode(200)
  @Post(':id/payments')
  addPayment(
    @BusinessId() businessId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: PaymentDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.sales.addPayment(businessId, id, dto, user.id);
  }

  @HttpCode(200)
  @Post(':id/deliver')
  deliver(@BusinessId() businessId: string, @Param('id', ParseUUIDPipe) id: string) {
    return this.sales.deliver(businessId, id);
  }

  @HttpCode(200)
  @Post(':id/cancel')
  cancel(@BusinessId() businessId: string, @Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthUser) {
    return this.sales.cancel(businessId, id, user.id);
  }
}
