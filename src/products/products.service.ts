import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { paginated } from '../common/pagination.dto.js';
import { roundPrice } from '../common/pricing.js';
import { MovementType, Prisma } from '../generated/prisma/client.js';
import { PrismaService, type Tx } from '../prisma/prisma.service.js';
import { StockService } from '../stock/stock.service.js';
import {
  BulkPricesDto,
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

  async list(businessId: string, q: ProductsQueryDto) {
    const where: Prisma.ProductWhereInput = {
      businessId,
      categoryId: q.categoryId,
      isActive: q.includeInactive ? undefined : true,
    };
    if (q.search) {
      const contains = { contains: q.search, mode: 'insensitive' } as const;
      where.OR = [
        { name: contains },
        { brand: contains },
        { variants: { some: { OR: [{ color: contains }, { barcode: q.search }] } } },
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

  async get(businessId: string, id: string) {
    const product = await this.prisma.product.findFirst({ where: { id, businessId }, include: productInclude });
    if (!product) throw new NotFoundException('No se encontró el producto');
    return product;
  }

  async create(businessId: string, dto: CreateProductDto, userId: string) {
    const { variants = [], ...data } = dto;
    await this.assertCategory(businessId, data.categoryId);
    return this.prisma.$transaction(async (tx) => {
      const product = await tx.product.create({ data: { ...data, businessId } });
      await this.createVariants(tx, product, variants, userId);
      return tx.product.findUniqueOrThrow({ where: { id: product.id }, include: productInclude });
    });
  }

  /** Alta de un producto dentro de una transacción ajena: la usa el registro de compras. */
  async createInTransaction(
    tx: Tx,
    businessId: string,
    data: { name: string; categoryId?: string },
    variants: CreateVariantDto[],
    userId: string,
  ) {
    await this.assertCategory(businessId, data.categoryId);
    const product = await tx.product.create({ data: { ...data, businessId } });
    return this.createVariants(tx, product, variants, userId);
  }

  async update(businessId: string, id: string, dto: UpdateProductDto) {
    await this.get(businessId, id);
    await this.assertCategory(businessId, dto.categoryId);
    return this.prisma.product.update({ where: { id }, data: dto, include: productInclude });
  }

  /** Un mismo precio para todas las variantes del producto. */
  async setPrice(businessId: string, id: string, price: number) {
    await this.get(businessId, id);
    await this.prisma.variant.updateMany({ where: { productId: id }, data: { price } });
    return this.get(businessId, id);
  }

  /**
   * Un producto con historial no se borra: se desactiva, para no perder
   * los movimientos y ventas que lo referencian.
   */
  async remove(businessId: string, id: string) {
    await this.get(businessId, id);
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

  async addVariant(businessId: string, productId: string, dto: CreateVariantDto, userId: string) {
    const product = await this.get(businessId, productId);
    return this.prisma.$transaction(async (tx) => {
      const [variant] = await this.createVariants(tx, product, [dto], userId);
      return tx.variant.findUniqueOrThrow({ where: { id: variant.id } });
    });
  }

  async updateVariant(businessId: string, id: string, dto: UpdateVariantDto) {
    await this.getVariant(businessId, id);
    return this.prisma.variant.update({ where: { id }, data: dto });
  }

  async removeVariant(businessId: string, id: string) {
    await this.getVariant(businessId, id);
    const used = await this.prisma.stockMovement.count({ where: { variantId: id } });
    if (used > 0) {
      await this.prisma.variant.update({ where: { id }, data: { isActive: false } });
      return { deleted: false, deactivated: true };
    }
    await this.prisma.variant.delete({ where: { id } });
    return { deleted: true, deactivated: false };
  }

  async getVariant(businessId: string, id: string) {
    const variant = await this.prisma.variant.findFirst({ where: { id, product: { businessId } }, include: variantInclude });
    if (!variant) throw new NotFoundException('No se encontró la prenda');
    return variant;
  }

  /**
   * Busca por lo que lee el escáner: el código de barras exacto. Si la prenda es del otro
   * emprendimiento se avisa cuál, para que el front ofrezca cambiar.
   */
  async lookup(businessId: string, code: string) {
    const value = code.trim();
    const variant = await this.prisma.variant.findUnique({
      where: { barcode: value },
      include: { product: { select: { id: true, name: true, brand: true, isActive: true, business: true } } },
    });
    if (!variant) throw new NotFoundException(`No hay ninguna prenda con el código ${value}`);
    const { business, ...product } = variant.product;
    if (business.id !== businessId) {
      throw new ConflictException({
        statusCode: 409,
        message: `Esta prenda es de ${business.name}`,
        businessId: business.id,
      });
    }
    return { ...variant, product };
  }

  async listVariants(businessId: string, q: VariantsQueryDto) {
    const conditions: Prisma.Sql[] = [Prisma.sql`p."businessId" = ${businessId} AND v."isActive" AND p."isActive"`];
    if (q.search) {
      const like = `%${q.search}%`;
      conditions.push(
        Prisma.sql`(p."name" ILIKE ${like} OR v."barcode" = ${q.search} OR v."color" ILIKE ${like})`,
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

  /**
   * Aumento masivo de precios. Sin `apply` solo devuelve la vista previa; con `apply`
   * actualiza todo en una transacción y devuelve lo que cambió.
   */
  async bulkPrices(businessId: string, dto: BulkPricesDto) {
    await this.assertCategory(businessId, dto.categoryId);
    const variants = await this.prisma.variant.findMany({
      where: { isActive: true, product: { businessId, isActive: true, categoryId: dto.categoryId } },
      include: { product: { select: { name: true } } },
      orderBy: [{ product: { name: 'asc' } }, { color: 'asc' }, { size: 'asc' }],
    });
    const changes = variants
      .map((variant) => {
        const oldPrice = variant.price.toNumber();
        const newPrice = roundPrice(oldPrice * (1 + dto.percent / 100), dto.roundTo ?? 0);
        return { id: variant.id, name: variant.product.name, color: variant.color, size: variant.size, oldPrice, newPrice };
      })
      .filter((change) => change.newPrice !== change.oldPrice);

    if (dto.apply) {
      await this.prisma.$transaction(
        changes.map((change) => this.prisma.variant.update({ where: { id: change.id }, data: { price: change.newPrice } })),
      );
    }
    return { applied: dto.apply === true, count: changes.length, changes };
  }

  private async assertCategory(businessId: string, categoryId?: string | null) {
    if (!categoryId) return;
    const category = await this.prisma.category.findFirst({ where: { id: categoryId, businessId }, select: { id: true } });
    if (!category) throw new BadRequestException('La categoría no existe');
  }

  private async createVariants(
    tx: Tx,
    product: { id: string },
    dtos: CreateVariantDto[],
    userId: string,
  ) {
    const created: { id: string }[] = [];
    for (const { initialStock = 0, barcode, ...data } of dtos) {
      const variant = await tx.variant.create({
        data: {
          ...data,
          productId: product.id,
          barcode: barcode ?? (await this.nextBarcode(tx)),
        },
      });
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
