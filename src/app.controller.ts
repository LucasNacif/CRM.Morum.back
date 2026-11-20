import { Controller, Get } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { Public } from './common/decorators.js';

@Controller()
export class AppController {
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
}
