import { Body, Controller, Get, Patch } from '@nestjs/common';
import { IsInt, IsNumber, IsOptional, Max, Min } from 'class-validator';
import { BusinessId } from '../common/business.js';
import { PrismaService } from '../prisma/prisma.service.js';

export class UpdateSettingsDto {
  /** Porcentaje que se suma al costo para sugerir el precio de venta. 100 = el doble del costo. */
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(10000)
  markupPercent?: number;

  /** Múltiplo al que se redondean los precios sugeridos (0 = sin redondeo). */
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(100000)
  roundTo?: number;

  /** Con cuántos días de anticipación avisar un saldo por cobrar. */
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(60)
  dueAlertDays?: number;
}

/** Configuración propia de cada emprendimiento. */
@Controller('settings')
export class SettingsController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  get(@BusinessId() businessId: string) {
    return this.prisma.settings.upsert({ where: { businessId }, update: {}, create: { businessId } });
  }

  @Patch()
  update(@BusinessId() businessId: string, @Body() { markupPercent, roundTo, dueAlertDays }: UpdateSettingsDto) {
    const data = { markupPercent, roundTo, dueAlertDays };
    return this.prisma.settings.upsert({ where: { businessId }, update: data, create: { businessId, ...data } });
  }
}
