import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { paginated } from '../common/pagination.dto.js';
import { MovementType, Prisma } from '../generated/prisma/client.js';
import { PrismaService, type Tx } from '../prisma/prisma.service.js';
import { AdjustStockDto, MovementsQueryDto } from './stock.dto.js';

export interface MovementInput {
  variantId: string;
  /** Con signo: positivo entra, negativo sale. */
  quantity: number;
  type: MovementType;
  userId: string;
  note?: string;
  saleId?: string;
  purchaseId?: string;
}

@Injectable()
export class StockService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Único punto donde cambia el stock. El update atómico bloquea la fila, así dos
   * ventas simultáneas de la última unidad no pueden dejar el saldo en negativo.
   */
  async applyMovement(tx: Tx, input: MovementInput) {
    if (!Number.isInteger(input.quantity) || input.quantity === 0) {
      throw new BadRequestException('La cantidad del movimiento no puede ser cero');
    }
    const variant = await tx.variant.update({
      where: { id: input.variantId },
      data: { stock: { increment: input.quantity } },
      select: { stock: true, size: true, color: true, product: { select: { name: true } } },
    });
    if (variant.stock < 0) {
      const available = variant.stock - input.quantity;
      throw new ConflictException(
        `Stock insuficiente para ${variant.product.name} (${variant.color} ${variant.size}): hay ${available} y se pidieron ${-input.quantity}`,
      );
    }
    return tx.stockMovement.create({
      data: {
        variantId: input.variantId,
        quantity: input.quantity,
        stockAfter: variant.stock,
        type: input.type,
        userId: input.userId,
        note: input.note,
        saleId: input.saleId,
        purchaseId: input.purchaseId,
      },
    });
  }

  adjust(dto: AdjustStockDto, userId: string) {
    return this.prisma.$transaction(async (tx) => {
      let delta = dto.quantity;
      if (dto.mode === 'set') {
        if (dto.quantity < 0) throw new BadRequestException('El stock contado no puede ser negativo');
        // Bloquea la fila para que el conteo se compare contra un saldo que no cambia.
        const rows = await tx.$queryRaw<{ stock: number }[]>(
          Prisma.sql`SELECT "stock" FROM "Variant" WHERE "id" = ${dto.variantId} FOR UPDATE`,
        );
        if (rows.length === 0) throw new NotFoundException('No se encontró la variante');
        delta = dto.quantity - rows[0].stock;
        if (delta === 0) throw new BadRequestException('El stock ya coincide con el conteo');
      }
      return this.applyMovement(tx, {
        variantId: dto.variantId,
        quantity: delta,
        type: MovementType.ADJUSTMENT,
        userId,
        note: dto.note,
      });
    });
  }

  async listMovements(q: MovementsQueryDto) {
    const where: Prisma.StockMovementWhereInput = {
      variantId: q.variantId,
      type: q.type,
      createdAt: q.from || q.to ? { gte: q.from, lte: q.to } : undefined,
    };
    const [items, total] = await Promise.all([
      this.prisma.stockMovement.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: q.skip,
        take: q.pageSize,
        include: {
          variant: {
            select: { barcode: true, size: true, color: true, product: { select: { id: true, name: true } } },
          },
          sale: { select: { id: true, number: true } },
          purchase: { select: { id: true, number: true } },
        },
      }),
      this.prisma.stockMovement.count({ where }),
    ]);
    return paginated(items, total, q);
  }
}
