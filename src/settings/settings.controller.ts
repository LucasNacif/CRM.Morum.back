import { Body, Controller, Get, Patch } from '@nestjs/common';
import { IsNumber, IsOptional, Max, Min } from 'class-validator';
import { PrismaService } from '../prisma/prisma.service.js';

// La configuración es una única fila.
const SETTINGS_ID = 1;

export class UpdateSettingsDto {
  /** Porcentaje que se suma al costo para sugerir el precio de venta. 100 = el doble del costo. */
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(10000)
  markupPercent?: number;
}

@Controller('settings')
export class SettingsController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  get() {
    return this.prisma.settings.upsert({ where: { id: SETTINGS_ID }, update: {}, create: { id: SETTINGS_ID } });
  }

  @Patch()
  update(@Body() { markupPercent }: UpdateSettingsDto) {
    return this.prisma.settings.upsert({
      where: { id: SETTINGS_ID },
      update: { markupPercent },
      create: { id: SETTINGS_ID, markupPercent },
    });
  }
}
