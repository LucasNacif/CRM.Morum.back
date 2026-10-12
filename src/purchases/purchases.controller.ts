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
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsDate,
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
import { MovementType, Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { StockService } from '../stock/stock.service.js';

export class PurchaseItemDto {
  @IsUUID()
  variantId: string;

  @IsInt()
  @Min(1)
  quantity: number;

  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  unitCost: number;
}

export class CreatePurchaseDto {
  @IsOptional()
  @IsUUID()
  supplierId?: string;

  @IsOptional()
  @Type(() => Date)
  @IsDate()
  date?: Date;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;

  /** Actualiza el costo de cada variante con el de esta compra. Por defecto sí. */
  @IsOptional()
  @IsBoolean()
  updateCost?: boolean;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(300)
  @ValidateNested({ each: true })
  @Type(() => PurchaseItemDto)
  items: PurchaseItemDto[];
}

const purchaseInclude = {
  supplier: { select: { id: true, name: true } },
  items: {
    include: {
      variant: {
        select: { sku: true, size: true, color: true, product: { select: { id: true, name: true } } },
      },
    },
  },
} satisfies Prisma.PurchaseInclude;

@Injectable()
export class PurchasesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly stock: StockService,
  ) {}

  create(dto: CreatePurchaseDto, userId: string) {
    const variantIds = dto.items.map((item) => item.variantId);
    if (new Set(variantIds).size !== variantIds.length) {
      throw new BadRequestException('Hay una variante repetida en la compra');
    }
    const total = dto.items.reduce(
      (sum, item) => sum.plus(new Prisma.Decimal(item.unitCost).times(item.quantity)),
      new Prisma.Decimal(0),
    );

    return this.prisma.$transaction(async (tx) => {
      const purchase = await tx.purchase.create({
        data: {
          supplierId: dto.supplierId,
          date: dto.date,
          note: dto.note,
          total,
          userId,
          items: { create: dto.items },
        },
      });
      for (const item of dto.items) {
        await this.stock.applyMovement(tx, {
          variantId: item.variantId,
          quantity: item.quantity,
          type: MovementType.PURCHASE,
          userId,
          purchaseId: purchase.id,
          note: `Compra #${purchase.number}`,
        });
        if (dto.updateCost !== false) {
          await tx.variant.update({ where: { id: item.variantId }, data: { cost: item.unitCost } });
        }
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
        include: { supplier: { select: { id: true, name: true } }, _count: { select: { items: true } } },
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
