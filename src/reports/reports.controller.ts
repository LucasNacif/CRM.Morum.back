import { Controller, Get, Injectable, Query, StreamableFile } from '@nestjs/common';
import { Type } from 'class-transformer';
import { IsDate, IsInt, IsOptional, Max, Min } from 'class-validator';
import { toCsv } from '../common/csv.js';
import { Prisma, SaleStatus } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';

const DAY = 24 * 60 * 60 * 1000;

export class ReportQueryDto {
  /**
   * Diferencia en minutos entre UTC y la hora local del navegador
   * (`new Date().getTimezoneOffset()`). Argentina: 180.
   */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(-840)
  @Max(840)
  tzOffset: number = 180;

  @IsOptional()
  @Type(() => Date)
  @IsDate()
  from?: Date;

  @IsOptional()
  @Type(() => Date)
  @IsDate()
  to?: Date;
}

const money = (value: { toFixed(digits: number): string }) => value.toFixed(2).replace('.', ',');

const PAYMENT_LABELS: Record<string, string> = {
  CASH: 'Efectivo',
  TRANSFER: 'Transferencia',
  DEBIT: 'Débito',
  CREDIT: 'Crédito',
  OTHER: 'Otro',
};

@Injectable()
export class ReportsService {
  constructor(private readonly prisma: PrismaService) {}

  async dashboard(tzOffset: number) {
    const shift = tzOffset * 60_000;
    // Se corre el reloj para leer año/mes/día locales con los getters UTC.
    const local = new Date(Date.now() - shift);
    const today = new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate()) + shift);
    const monthStart = new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), 1) + shift);
    const last14 = new Date(today.getTime() - 13 * DAY);
    const last30 = new Date(today.getTime() - 29 * DAY);

    const [[stock], lowStock, salesToday, salesMonth, [monthCost], topProducts, salesByDay] = await Promise.all([
      this.prisma.$queryRaw<
        { units: number; costValue: number; retailValue: number; variants: number; lowStockCount: number }[]
      >(Prisma.sql`
        SELECT COALESCE(SUM(v."stock"), 0)::int AS "units",
               COALESCE(SUM(v."stock" * v."cost"), 0)::float8 AS "costValue",
               COALESCE(SUM(v."stock" * v."price"), 0)::float8 AS "retailValue",
               COUNT(*)::int AS "variants",
               (COUNT(*) FILTER (WHERE v."stock" <= v."minStock"))::int AS "lowStockCount"
        FROM "Variant" v JOIN "Product" p ON p."id" = v."productId"
        WHERE v."isActive" AND p."isActive"`),
      this.prisma.$queryRaw<
        { id: string; productId: string; name: string; size: string; color: string; stock: number; minStock: number }[]
      >(Prisma.sql`
        SELECT v."id", p."id" AS "productId", p."name", v."size", v."color", v."stock", v."minStock"
        FROM "Variant" v JOIN "Product" p ON p."id" = v."productId"
        WHERE v."isActive" AND p."isActive" AND v."stock" <= v."minStock"
        ORDER BY v."stock" - v."minStock", p."name"
        LIMIT 10`),
      this.salesTotals(today),
      this.salesTotals(monthStart),
      this.prisma.$queryRaw<{ cost: number }[]>(Prisma.sql`
        SELECT COALESCE(SUM(i."quantity" * i."unitCost"), 0)::float8 AS "cost"
        FROM "SaleItem" i JOIN "Sale" s ON s."id" = i."saleId"
        WHERE s."status" = 'COMPLETED' AND s."date" >= ${monthStart}`),
      this.prisma.$queryRaw<{ productId: string; name: string; units: number; revenue: number }[]>(Prisma.sql`
        SELECT p."id" AS "productId", p."name",
               SUM(i."quantity")::int AS "units",
               SUM(i."quantity" * i."unitPrice")::float8 AS "revenue"
        FROM "SaleItem" i
        JOIN "Sale" s ON s."id" = i."saleId"
        JOIN "Variant" v ON v."id" = i."variantId"
        JOIN "Product" p ON p."id" = v."productId"
        WHERE s."status" = 'COMPLETED' AND s."date" >= ${last30}
        GROUP BY p."id", p."name"
        ORDER BY "units" DESC, "revenue" DESC
        LIMIT 5`),
      this.prisma.$queryRaw<{ day: string; count: number; total: number }[]>(Prisma.sql`
        SELECT to_char(s."date" - make_interval(mins => ${tzOffset}::int), 'YYYY-MM-DD') AS "day",
               COUNT(*)::int AS "count",
               SUM(s."total")::float8 AS "total"
        FROM "Sale" s
        WHERE s."status" = 'COMPLETED' AND s."date" >= ${last14}
        GROUP BY 1 ORDER BY 1`),
    ]);

    // Se completan los días sin ventas para que la serie no tenga huecos.
    const byDay = new Map(salesByDay.map((row) => [row.day, row]));
    const series = Array.from({ length: 14 }, (_, i) => {
      const day = new Date(last14.getTime() - shift + i * DAY).toISOString().slice(0, 10);
      return byDay.get(day) ?? { day, count: 0, total: 0 };
    });

    return {
      stock,
      lowStock,
      salesToday,
      salesMonth: { ...salesMonth, profit: salesMonth.total - monthCost.cost },
      topProducts,
      salesByDay: series,
    };
  }

  private async salesTotals(since: Date) {
    const result = await this.prisma.sale.aggregate({
      where: { status: SaleStatus.COMPLETED, date: { gte: since } },
      _sum: { total: true },
      _count: true,
    });
    return { count: result._count, total: result._sum.total?.toNumber() ?? 0 };
  }

  async stockCsv() {
    const variants = await this.prisma.variant.findMany({
      where: { isActive: true, product: { isActive: true } },
      include: { product: { include: { category: true } } },
      orderBy: [{ product: { name: 'asc' } }, { color: 'asc' }, { size: 'asc' }],
    });
    return toCsv(
      ['Producto', 'Categoría', 'Color', 'Talle', 'Código de barras', 'Stock', 'Stock mínimo', 'Costo', 'Precio', 'Valor a costo', 'Valor a precio'],
      variants.map((v) => [
        v.product.name,
        v.product.category?.name,
        v.color,
        v.size,
        v.barcode,
        v.stock,
        v.minStock,
        money(v.cost),
        money(v.price),
        money(v.cost.times(v.stock)),
        money(v.price.times(v.stock)),
      ]),
    );
  }

  async salesCsv(q: ReportQueryDto) {
    const sales = await this.prisma.sale.findMany({
      where: { date: q.from || q.to ? { gte: q.from, lte: q.to } : undefined },
      orderBy: { date: 'asc' },
      include: { items: { include: { variant: { include: { product: true } } } } },
    });
    const localDate = (date: Date) => {
      const iso = new Date(date.getTime() - q.tzOffset * 60_000).toISOString();
      return `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)} ${iso.slice(11, 16)}`;
    };
    return toCsv(
      ['Venta', 'Fecha', 'Estado', 'Producto', 'Color', 'Talle', 'Código de barras', 'Cantidad', 'Precio unitario', 'Costo unitario', 'Medio de pago', 'Descuento de la venta', 'Total de la venta', 'Cliente'],
      sales.flatMap((sale) =>
        sale.items.map((item) => [
          sale.number,
          localDate(sale.date),
          sale.status === SaleStatus.COMPLETED ? 'Completada' : 'Anulada',
          item.variant.product.name,
          item.variant.color,
          item.variant.size,
          item.variant.barcode,
          item.quantity,
          money(item.unitPrice),
          money(item.unitCost),
          PAYMENT_LABELS[sale.paymentMethod],
          money(sale.discount),
          money(sale.total),
          sale.customerName,
        ]),
      ),
    );
  }
}

function csvFile(content: string, filename: string) {
  return new StreamableFile(Buffer.from(content, 'utf8'), {
    type: 'text/csv; charset=utf-8',
    disposition: `attachment; filename="${filename}"`,
  });
}

@Controller('reports')
export class ReportsController {
  constructor(private readonly reports: ReportsService) {}

  @Get('dashboard')
  dashboard(@Query() q: ReportQueryDto) {
    return this.reports.dashboard(q.tzOffset);
  }

  @Get('stock.csv')
  async stockCsv() {
    return csvFile(await this.reports.stockCsv(), 'stock.csv');
  }

  @Get('sales.csv')
  async salesCsv(@Query() q: ReportQueryDto) {
    return csvFile(await this.reports.salesCsv(q), 'ventas.csv');
  }
}
