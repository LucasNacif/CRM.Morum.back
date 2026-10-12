import { BadRequestException, Body, Controller, Delete, Get, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { Transform } from 'class-transformer';
import { IsEmail, IsString, MaxLength, MinLength } from 'class-validator';
import bcrypt from 'bcryptjs';
import { CurrentUser, type AuthUser } from '../common/decorators.js';
import { PrismaService } from '../prisma/prisma.service.js';

export class CreateUserDto {
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MinLength(1)
  @MaxLength(60)
  name: string;

  @Transform(({ value }) => (typeof value === 'string' ? value.toLowerCase().trim() : value))
  @IsEmail()
  email: string;

  @IsString()
  @MinLength(8, { message: 'La contraseña debe tener al menos 8 caracteres' })
  @MaxLength(100)
  password: string;
}

const publicFields = { id: true, name: true, email: true, createdAt: true } as const;

@Controller('users')
export class UsersController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  list() {
    return this.prisma.user.findMany({ where: { isActive: true }, select: publicFields, orderBy: { createdAt: 'asc' } });
  }

  @Post()
  async create(@Body() { password, ...data }: CreateUserDto) {
    const passwordHash = await bcrypt.hash(password, 12);
    const existing = await this.prisma.user.findUnique({ where: { email: data.email } });
    // Un email dado de baja se puede volver a usar: se reactiva con los datos nuevos.
    if (existing && !existing.isActive) {
      return this.prisma.user.update({
        where: { id: existing.id },
        data: { ...data, passwordHash, isActive: true },
        select: publicFields,
      });
    }
    return this.prisma.user.create({ data: { ...data, passwordHash }, select: publicFields });
  }

  /** Con ventas, compras o movimientos a su nombre se da de baja en lugar de borrarse. */
  @Delete(':id')
  async remove(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() current: AuthUser) {
    if (id === current.id) throw new BadRequestException('No podés eliminar tu propio usuario');
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id },
      select: { _count: { select: { movements: true, sales: true, purchases: true } } },
    });
    const { movements, sales, purchases } = user._count;
    if (movements + sales + purchases > 0) {
      await this.prisma.user.update({ where: { id }, data: { isActive: false } });
      return { deleted: false, deactivated: true };
    }
    await this.prisma.user.delete({ where: { id } });
    return { deleted: true, deactivated: false };
  }
}
