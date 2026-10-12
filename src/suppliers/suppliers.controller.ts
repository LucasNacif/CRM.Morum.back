import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Patch, Post } from '@nestjs/common';
import { Transform } from 'class-transformer';
import { IsBoolean, IsEmail, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { PrismaService } from '../prisma/prisma.service.js';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);
const emptyToNull = ({ value }: { value: unknown }) =>
  typeof value === 'string' && value.trim() === '' ? null : trim({ value });

class SupplierContactDto {
  @IsOptional()
  @Transform(emptyToNull)
  @IsString()
  @MaxLength(40)
  phone?: string | null;

  @IsOptional()
  @Transform(emptyToNull)
  @IsEmail()
  email?: string | null;

  @IsOptional()
  @Transform(emptyToNull)
  @IsString()
  @MaxLength(1000)
  notes?: string | null;
}

export class SupplierDto extends SupplierContactDto {
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  name: string;
}

export class UpdateSupplierDto extends SupplierContactDto {
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  name?: string;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

@Controller('suppliers')
export class SuppliersController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  list() {
    return this.prisma.supplier.findMany({
      where: { isActive: true },
      orderBy: { name: 'asc' },
      include: { _count: { select: { purchases: true } } },
    });
  }

  @Post()
  create(@Body() dto: SupplierDto) {
    return this.prisma.supplier.create({ data: dto });
  }

  @Patch(':id')
  update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateSupplierDto) {
    return this.prisma.supplier.update({ where: { id }, data: dto });
  }

  // Con compras asociadas se archiva en lugar de borrarse, para conservar el historial.
  @Delete(':id')
  async remove(@Param('id', ParseUUIDPipe) id: string) {
    const purchases = await this.prisma.purchase.count({ where: { supplierId: id } });
    if (purchases > 0) {
      await this.prisma.supplier.update({ where: { id }, data: { isActive: false } });
      return { deleted: false, deactivated: true };
    }
    await this.prisma.supplier.delete({ where: { id } });
    return { deleted: true, deactivated: false };
  }
}
