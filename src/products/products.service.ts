import { Injectable, NotFoundException } from '@nestjs/common';
import { paginated } from '../common/pagination.dto.js';
import { MovementType, Prisma } from '../generated/prisma/client.js';
import { PrismaService, type Tx } from '../prisma/prisma.service.js';
import { StockService } from '../stock/stock.service.js';
import { buildSku, uniqueSku } from './codes.js';
import {
  CreateProductDto,
  CreateVariantDto,
  ProductsQueryDto,
  UpdateProductDto,
  UpdateVariantDto,
  VariantsQueryDto,
} from './products.dto.js';

const productInclude = {
  category: true,
  variants: { orderBy: [{ color: 'asc' }, { size: 'asc' }] },
} satisfies Prisma.ProductInclude;

const variantInclude = {
  product: { select: { id: true, name: true, brand: true, isActive: true } },
} satisfies Prisma.VariantInclude;

@Injectable()
export class ProductsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly stock: StockService,
  ) {}

  async list(q: ProductsQueryDto) {
    const where: Prisma.ProductWhereInput = {
      categoryId: q.categoryId,
      isActive: q.includeInactive ? undefined : true,
    };
    if (q.search) {
      const contains = { contains: q.search, mode: 'insensitive' } as const;
      where.OR = [
        { name: contains },
        { brand: contains },
        { variants: { some: { OR: [{ sku: contains }, { barcode: q.search }] } } },
      ];
    }
    const [items, total] = await Promise.all([
      this.prisma.product.findMany({
        where,
        include: productInclude,
        orderBy: { name: 'asc' },
        skip: q.skip,
        take: q.pageSize,
      }),
      this.prisma.product.count({ where }),
    ]);
    return paginated(items, total, q);
  }

  async get(id: string) {
    const product = await this.prisma.product.findUnique({ where: { id }, include: productInclude });
    if (!product) throw new NotFoundException('No se encontró el producto');
    return product;
  }

  create(dto: CreateProductDto, userId: string) {
    const { variants = [], ...data } = dto;
    return this.prisma.$transaction(async (tx) => {
      const product = await tx.product.create({ data });
      await this.createVariants(tx, product, variants, userId);
      return tx.product.findUniqueOrThrow({ where: { id: product.id }, include: productInclude });
    });
  }

  update(id: string, dto: UpdateProductDto) {
    return this.prisma.product.update({ where: { id }, data: dto, include: productInclude });
  }

  /**
   * Un producto con historial no se borra: se desactiva, para no perder
   * los movimientos, ventas y compras que lo referencian.
   */
  async remove(id: string) {
    const used = await this.prisma.stockMovement.count({ where: { variant: { productId: id } } });
    if (used > 0) {
      await this.prisma.$transaction([
        this.prisma.variant.updateMany({ where: { productId: id }, data: { isActive: false } }),
        this.prisma.product.update({ where: { id }, data: { isActive: false, isPublished: false } }),
      ]);
      return { deleted: false, deactivated: true };
    }
    await this.prisma.product.delete({ where: { id } });
    return { deleted: true, deactivated: false };
  }

  addVariant(productId: string, dto: CreateVariantDto, userId: string) {
    return this.prisma.$transaction(async (tx) => {
      const product = await tx.product.findUnique({ where: { id: productId } });
      if (!product) throw new NotFoundException('No se encontró el producto');
      const [variant] = await this.createVariants(tx, product, [dto], userId);
      return tx.variant.findUniqueOrThrow({ where: { id: variant.id } });
    });
  }

  updateVariant(id: string, dto: UpdateVariantDto) {
    return this.prisma.variant.update({ where: { id }, data: dto });
  }

  async removeVariant(id: string) {
    const used = await this.prisma.stockMovement.count({ where: { variantId: id } });
    if (used > 0) {
      await this.prisma.variant.update({ where: { id }, data: { isActive: false } });
      return { deleted: false, deactivated: true };
    }
    await this.prisma.variant.delete({ where: { id } });
    return { deleted: true, deactivated: false };
  }

  /** Busca por lo que lee el escáner: código de barras exacto o, si no, SKU. */
  async lookup(code: string) {
    const value = code.trim();
    const variant =
      (await this.prisma.variant.findUnique({ where: { barcode: value }, include: variantInclude })) ??
      (await this.prisma.variant.findFirst({
        where: { sku: { equals: value, mode: 'insensitive' } },
        include: variantInclude,
      }));
    if (!variant) throw new NotFoundException(`No hay ninguna prenda con el código ${value}`);
    return variant;
  }

  async listVariants(q: VariantsQueryDto) {
    const conditions: Prisma.Sql[] = [Prisma.sql`v."isActive" AND p."isActive"`];
    if (q.search) {
      const like = `%${q.search}%`;
      conditions.push(
        Prisma.sql`(p."name" ILIKE ${like} OR v."sku" ILIKE ${like} OR v."barcode" = ${q.search} OR v."color" ILIKE ${like})`,
      );
    }
    // Comparar dos columnas entre sí no se puede expresar con el where de Prisma.
    if (q.lowStock) conditions.push(Prisma.sql`v."stock" <= v."minStock"`);
    const where = Prisma.join(conditions, ' AND ');

    const [rows, count] = await Promise.all([
      this.prisma.$queryRaw<{ id: string }[]>(Prisma.sql`
        SELECT v."id" FROM "Variant" v JOIN "Product" p ON p."id" = v."productId"
        WHERE ${where}
        ORDER BY p."name", v."color", v."size"
        LIMIT ${q.pageSize} OFFSET ${q.skip}`),
      this.prisma.$queryRaw<{ total: number }[]>(Prisma.sql`
        SELECT COUNT(*)::int AS total FROM "Variant" v JOIN "Product" p ON p."id" = v."productId"
        WHERE ${where}`),
    ]);
    const ids = rows.map((row) => row.id);
    const variants = await this.prisma.variant.findMany({
      where: { id: { in: ids } },
      include: variantInclude,
    });
    const byId = new Map(variants.map((variant) => [variant.id, variant]));
    const items = ids.flatMap((id) => byId.get(id) ?? []);
    return paginated(items, count[0].total, q);
  }

  private async createVariants(
    tx: Tx,
    product: { id: string; name: string },
    dtos: CreateVariantDto[],
    userId: string,
  ) {
    const created: { id: string }[] = [];
    const assigned = new Set<string>();
    for (const { initialStock = 0, sku, barcode, ...data } of dtos) {
      const variant = await tx.variant.create({
        data: {
          ...data,
          productId: product.id,
          sku: sku ?? (await this.nextSku(tx, buildSku(product.name, data.color, data.size), assigned)),
          barcode: barcode ?? (await this.nextBarcode(tx)),
        },
      });
      assigned.add(variant.sku);
      if (initialStock > 0) {
        await this.stock.applyMovement(tx, {
          variantId: variant.id,
          quantity: initialStock,
          type: MovementType.INITIAL,
          userId,
          note: 'Stock inicial',
        });
      }
      created.push(variant);
    }
    return created;
  }

  private async nextSku(tx: Tx, base: string, assigned: Set<string>) {
    const existing = await tx.variant.findMany({
      where: { sku: { startsWith: base } },
      select: { sku: true },
    });
    return uniqueSku(base, new Set([...existing.map((v) => v.sku), ...assigned]));
  }

  private async nextBarcode(tx: Tx): Promise<string> {
    // Se saltea cualquier número que ya se haya cargado a mano como código de fábrica.
    for (;;) {
      const [{ value }] = await tx.$queryRaw<{ value: bigint }[]>(
        Prisma.sql`SELECT nextval('barcode_seq') AS value`,
      );
      const barcode = value.toString();
      if (!(await tx.variant.findUnique({ where: { barcode }, select: { id: true } }))) return barcode;
    }
  }
}
