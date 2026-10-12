import { ArgumentsHost, Catch, ExceptionFilter, HttpStatus } from '@nestjs/common';
import type { Response } from 'express';
import { Prisma } from '../generated/prisma/client.js';

/** Traduce los errores conocidos de Prisma a respuestas HTTP legibles. */
@Catch(Prisma.PrismaClientKnownRequestError)
export class PrismaExceptionFilter implements ExceptionFilter {
  catch(error: Prisma.PrismaClientKnownRequestError, host: ArgumentsHost) {
    const res = host.switchToHttp().getResponse<Response>();
    const [status, message] = this.translate(error);
    res.status(status).json({ statusCode: status, message });
  }

  private translate(error: Prisma.PrismaClientKnownRequestError): [number, string] {
    switch (error.code) {
      case 'P2002':
        return [HttpStatus.CONFLICT, 'Ya existe un registro con esos datos'];
      case 'P2025':
        return [HttpStatus.NOT_FOUND, 'No se encontró el registro'];
      case 'P2003':
        return [HttpStatus.CONFLICT, 'El registro está en uso o referencia algo que no existe'];
      default:
        console.error(error);
        return [HttpStatus.INTERNAL_SERVER_ERROR, 'Error interno'];
    }
  }
}
