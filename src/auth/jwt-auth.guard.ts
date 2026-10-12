import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import type { Request } from 'express';
import { IS_PUBLIC_KEY, type AuthUser } from '../common/decorators.js';
import { PrismaService } from '../prisma/prisma.service.js';

/** Guard global: toda ruta exige token salvo las marcadas con @Public(). */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly jwt: JwtService,
    private readonly reflector: Reflector,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const req = context.switchToHttp().getRequest<Request & { user?: AuthUser }>();
    const [scheme, token] = req.headers.authorization?.split(' ') ?? [];
    if (scheme !== 'Bearer' || !token) throw new UnauthorizedException('Sesión no iniciada');

    let payload: { sub: string; email: string };
    try {
      payload = await this.jwt.verifyAsync(token);
    } catch {
      throw new UnauthorizedException('Sesión vencida');
    }
    // El token dura semanas: se confirma en cada pedido que el usuario siga existiendo y activo.
    const user = await this.prisma.user.findUnique({ where: { id: payload.sub }, select: { isActive: true } });
    if (!user?.isActive) throw new UnauthorizedException('Sesión vencida');
    req.user = { id: payload.sub, email: payload.email };
    return true;
  }
}
