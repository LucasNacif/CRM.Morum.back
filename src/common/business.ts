import {
  BadRequestException,
  CanActivate,
  createParamDecorator,
  ExecutionContext,
  Injectable,
} from '@nestjs/common';
import type { Request } from 'express';
import { PrismaService } from '../prisma/prisma.service.js';

type BusinessRequest = Request & { businessId?: string };

/**
 * Lee el negocio activo del encabezado `X-Business` que manda el front. Si viene, tiene que
 * existir; si no viene, las rutas que lo necesitan lo rechazan al pedirlo con `@BusinessId()`.
 */
@Injectable()
export class BusinessGuard implements CanActivate {
  private known: Set<string> | null = null;

  constructor(private readonly prisma: PrismaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<BusinessRequest>();
    const header = req.headers['x-business'];
    if (typeof header !== 'string' || header === '') return true;

    // Los negocios no cambian en tiempo de ejecución: se leen una vez.
    this.known ??= new Set((await this.prisma.business.findMany({ select: { id: true } })).map((b) => b.id));
    if (!this.known.has(header)) throw new BadRequestException('Emprendimiento desconocido');
    req.businessId = header;
    return true;
  }
}

/** Id del negocio activo. Toda consulta de datos del negocio se filtra con este valor. */
export const BusinessId = createParamDecorator((_: unknown, ctx: ExecutionContext): string => {
  const businessId = ctx.switchToHttp().getRequest<BusinessRequest>().businessId;
  if (!businessId) throw new BadRequestException('Falta indicar el emprendimiento');
  return businessId;
});
