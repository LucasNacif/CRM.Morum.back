import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { MovementType, Prisma } from '../generated/prisma/client.js';
import { PrismaService, type Tx } from '../prisma/prisma.service.js';
import { AdjustStockDto } from './stock.dto.js';

export interface MovementInput {
  variantId: string;
  /** Con signo: positivo entra, negativo sale. */
  quantity: number;
  type: MovementType;
  userId: string;
  note?: string;
  saleId?: string;
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
      },
    });
  }

  /**
   * Entrada, salida o conteo. Una entrada con costo es una reposición: actualiza el costo
   * de la prenda y, si se manda, también el precio de venta.
   */
  async adjust(businessId: string, dto: AdjustStockDto, userId: string) {
    const owned = await this.prisma.variant.count({ where: { id: dto.variantId, product: { businessId } } });
    if (!owned) throw new NotFoundException('No se encontró la prenda');
    const restock = dto.mode === 'delta' && dto.quantity > 0 && dto.cost !== undefined;
    if ((dto.cost !== undefined || dto.price !== undefined) && !restock) {
      throw new BadRequestException('El costo y el precio solo se cargan en una entrada de stock');
    }

    return this.prisma.$transaction(async (tx) => {
      let delta = dto.quantity;
      if (dto.mode === 'set') {
        if (dto.quantity < 0) throw new BadRequestException('El stock contado no puede ser negativo');
        // Bloquea la fila para que el conteo se compare contra un saldo que no cambia.
        const rows = await tx.$queryRaw<{ stock: number }[]>(
          Prisma.sql`SELECT "stock" FROM "Variant" WHERE "id" = ${dto.variantId} FOR UPDATE`,
        );
        delta = dto.quantity - rows[0].stock;
        if (delta === 0) throw new BadRequestException('El stock ya coincide con el conteo');
      }
      const movement = await this.applyMovement(tx, {
        variantId: dto.variantId,
        quantity: delta,
        type: restock ? MovementType.RESTOCK : MovementType.ADJUSTMENT,
        userId,
        note: dto.note,
      });
      if (restock) {
        await tx.variant.update({ where: { id: dto.variantId }, data: { cost: dto.cost, price: dto.price } });
      }
      return movement;
    });
  }
}
