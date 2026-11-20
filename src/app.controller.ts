import { Controller, Get } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { Public } from './common/decorators.js';
import { PrismaService } from './prisma/prisma.service.js';

@Controller()
export class AppController {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Usado por el hosting, el cron que evita que Render se duerma y el login para despertarlo. No toca la base a
   * propósito: Neon se suspende tras unos minutos sin consultas, y un `SELECT 1` en cada chequeo la mantenía despierta
   * todo el día hasta agotar las horas del plan. La base se despierta sola con la primera consulta real.
   */
  @Public()
  @SkipThrottle()
  @Get('health')
  health() {
    return { status: 'ok' };
  }

  /** Comprueba la conexión a la base, para diagnosticar a mano. No usarlo en chequeos automáticos (ver arriba). */
  @Public()
  @Get('health/db')
  async healthDb() {
    await this.prisma.$queryRaw`SELECT 1`;
    return { status: 'ok' };
  }
}
