import { Controller, Get, Injectable, Query } from '@nestjs/common';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, Max, Min } from 'class-validator';
import { BusinessId } from '../common/business.js';
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
}

@Injectable()
export class ReportsService {
  constructor(private readonly prisma: PrismaService) {}

  async dashboard(businessId: string, tzOffset: number) {
    const shift = tzOffset * 60_000;
    // Se corre el reloj para leer año/mes/día locales con los getters UTC.
    const local = new Date(Date.now() - shift);
    const today = new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate()) + shift);
    const monthStart = new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), 1) + shift);
    const last14 = new Date(today.getTime() - 13 * DAY);
    const last30 = new Date(today.getTime() - 29 * DAY);

    const [[stock], lowStock, salesToday, salesMonth, collectedToday, collectedMonth, [monthCost], [receivable], topProducts, salesByDay] =
      await Promise.all([
        this.prisma.$queryRaw<
          { units: number; costValue: number; retailValue: number; variants: number; lowStockCount: number }[]
        >(Prisma.sql`
          SELECT COALESCE(SUM(v."stock"), 0)::int AS "units",
                 COALESCE(SUM(v."stock" * v."cost"), 0)::float8 AS "costValue",
                 COALESCE(SUM(v."stock" * v."price"), 0)::float8 AS "retailValue",
                 COUNT(*)::int AS "variants",
                 (COUNT(*) FILTER (WHERE v."stock" <= v."minStock"))::int AS "lowStockCount"
          FROM "Variant" v JOIN "Product" p ON p."id" = v."productId"
          WHERE p."businessId" = ${businessId} AND v."isActive" AND p."isActive"`),
        this.prisma.$queryRaw<
          { id: string; productId: string; name: string; size: string; color: string; stock: number; minStock: number }[]
        >(Prisma.sql`
          SELECT v."id", p."id" AS "productId", p."name", v."size", v."color", v."stock", v."minStock"
          FROM "Variant" v JOIN "Product" p ON p."id" = v."productId"
          WHERE p."businessId" = ${businessId} AND v."isActive" AND p."isActive" AND v."stock" <= v."minStock"
          ORDER BY v."stock" - v."minStock", p."name"
          LIMIT 10`),
        this.salesTotals(businessId, today),
        this.salesTotals(businessId, monthStart),
        this.collected(businessId, today),
        this.collected(businessId, monthStart),
        this.prisma.$queryRaw<{ cost: number }[]>(Prisma.sql`
          SELECT COALESCE(SUM(i."quantity" * i."unitCost"), 0)::float8 AS "cost"
          FROM "SaleItem" i JOIN "Sale" s ON s."id" = i."saleId"
          WHERE s."businessId" = ${businessId} AND s."status" = 'COMPLETED' AND s."date" >= ${monthStart}`),
        this.prisma.$queryRaw<{ total: number; count: number }[]>(Prisma.sql`
          SELECT COALESCE(SUM(s."total" - s."paidAmount"), 0)::float8 AS "total", COUNT(*)::int AS "count"
          FROM "Sale" s
          WHERE s."businessId" = ${businessId} AND s."status" = 'COMPLETED' AND s."paidAmount" < s."total"`),
        this.prisma.$queryRaw<{ productId: string; name: string; units: number; revenue: number }[]>(Prisma.sql`
          SELECT p."id" AS "productId", p."name",
                 SUM(i."quantity")::int AS "units",
                 SUM(i."quantity" * i."unitPrice")::float8 AS "revenue"
          FROM "SaleItem" i
          JOIN "Sale" s ON s."id" = i."saleId"
          JOIN "Variant" v ON v."id" = i."variantId"
          JOIN "Product" p ON p."id" = v."productId"
          WHERE s."businessId" = ${businessId} AND s."status" = 'COMPLETED' AND s."date" >= ${last30}
          GROUP BY p."id", p."name"
          ORDER BY "units" DESC, "revenue" DESC
          LIMIT 5`),
        this.prisma.$queryRaw<{ day: string; count: number; total: number }[]>(Prisma.sql`
          SELECT to_char(s."date" - make_interval(mins => ${tzOffset}::int), 'YYYY-MM-DD') AS "day",
                 COUNT(*)::int AS "count",
                 SUM(s."total")::float8 AS "total"
          FROM "Sale" s
          WHERE s."businessId" = ${businessId} AND s."status" = 'COMPLETED' AND s."date" >= ${last14}
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
      salesToday: { ...salesToday, collected: collectedToday },
      salesMonth: { ...salesMonth, collected: collectedMonth, profit: salesMonth.total - monthCost.cost },
      receivable,
      topProducts,
      salesByDay: series,
    };
  }

  /** Lo vendido: el total de las ventas, aunque una parte esté sin cobrar. */
  private async salesTotals(businessId: string, since: Date) {
    const result = await this.prisma.sale.aggregate({
      where: { businessId, status: SaleStatus.COMPLETED, date: { gte: since } },
      _sum: { total: true },
      _count: true,
    });
    return { count: result._count, total: result._sum.total?.toNumber() ?? 0 };
  }

  /** Lo cobrado: los pagos recibidos en el período, incluidos saldos de ventas anteriores. */
  private async collected(businessId: string, since: Date) {
    const result = await this.prisma.payment.aggregate({
      where: { createdAt: { gte: since }, sale: { businessId, status: SaleStatus.COMPLETED } },
      _sum: { amount: true },
    });
    return result._sum.amount?.toNumber() ?? 0;
  }
}

@Controller('reports')
export class ReportsController {
  constructor(private readonly reports: ReportsService) {}

  @Get('dashboard')
  dashboard(@BusinessId() businessId: string, @Query() q: ReportQueryDto) {
    return this.reports.dashboard(businessId, q.tzOffset);
  }
}
