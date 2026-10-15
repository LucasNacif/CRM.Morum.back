import { Body, Controller, Delete, Get, HttpCode, NotFoundException, Param, ParseUUIDPipe, Patch, Post } from '@nestjs/common';
import { Transform } from 'class-transformer';
import { IsString, MaxLength, MinLength } from 'class-validator';
import { BusinessId } from '../common/business.js';
import { PrismaService } from '../prisma/prisma.service.js';

export class CategoryDto {
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MinLength(1)
  @MaxLength(60)
  name: string;
}

@Controller('categories')
export class CategoriesController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  list(@BusinessId() businessId: string) {
    return this.prisma.category.findMany({
      where: { businessId },
      orderBy: { name: 'asc' },
      include: { _count: { select: { products: true } } },
    });
  }

  @Post()
  create(@BusinessId() businessId: string, @Body() dto: CategoryDto) {
    return this.prisma.category.create({ data: { name: dto.name, businessId } });
  }

  @Patch(':id')
  async update(@BusinessId() businessId: string, @Param('id', ParseUUIDPipe) id: string, @Body() dto: CategoryDto) {
    const { count } = await this.prisma.category.updateMany({ where: { id, businessId }, data: { name: dto.name } });
    if (count === 0) throw new NotFoundException('No se encontró la categoría');
    return this.prisma.category.findUniqueOrThrow({ where: { id } });
  }

  // Los productos de la categoría quedan sin categoría (onDelete: SetNull).
  @Delete(':id')
  @HttpCode(204)
  async remove(@BusinessId() businessId: string, @Param('id', ParseUUIDPipe) id: string) {
    const { count } = await this.prisma.category.deleteMany({ where: { id, businessId } });
    if (count === 0) throw new NotFoundException('No se encontró la categoría');
  }
}
