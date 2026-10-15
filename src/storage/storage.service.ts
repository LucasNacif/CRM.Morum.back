import { DeleteObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

const UPLOAD_TTL_SECONDS = 300;

/**
 * Archivos en Cloudflare R2 (API compatible con S3). En desarrollo, R2_ENDPOINT apunta a un
 * simulador local. Los archivos se suben directo desde el navegador con URLs firmadas: la API
 * nunca recibe las imágenes, solo firma permisos y guarda dónde quedaron.
 */
@Injectable()
export class StorageService {
  private readonly logger = new Logger(StorageService.name);
  private readonly client: S3Client | null;
  private readonly bucket: string;
  private readonly publicUrl: string;

  constructor(config: ConfigService) {
    const accountId = config.get<string>('R2_ACCOUNT_ID');
    const endpoint = config.get<string>('R2_ENDPOINT') || (accountId ? `https://${accountId}.r2.cloudflarestorage.com` : undefined);
    const accessKeyId = config.get<string>('R2_ACCESS_KEY_ID');
    const secretAccessKey = config.get<string>('R2_SECRET_ACCESS_KEY');
    this.bucket = config.get<string>('R2_BUCKET') ?? '';
    this.publicUrl = (config.get<string>('R2_PUBLIC_URL') ?? '').replace(/\/$/, '');

    const configured = endpoint && accessKeyId && secretAccessKey && this.bucket && this.publicUrl;
    this.client = configured
      ? new S3Client({
          region: 'auto',
          endpoint,
          forcePathStyle: true,
          credentials: { accessKeyId, secretAccessKey },
          // Sin esto el SDK firma un checksum del cuerpo vacío y la subida desde el navegador falla.
          requestChecksumCalculation: 'WHEN_REQUIRED',
          responseChecksumValidation: 'WHEN_REQUIRED',
        })
      : null;
    if (!configured) this.logger.warn('Fotos deshabilitadas: faltan las variables R2_*');
  }

  private get s3(): S3Client {
    if (!this.client) throw new ServiceUnavailableException('El guardado de fotos no está configurado');
    return this.client;
  }

  /** URL firmada para subir un archivo con un PUT, válida unos minutos. */
  presignUpload(key: string, contentType: string) {
    return getSignedUrl(this.s3, new PutObjectCommand({ Bucket: this.bucket, Key: key, ContentType: contentType }), {
      expiresIn: UPLOAD_TTL_SECONDS,
    });
  }

  async exists(key: string) {
    try {
      await this.s3.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return true;
    } catch {
      return false;
    }
  }

  /** Borra archivos sin fallar: un archivo que no se pudo borrar no debe trabar la operación. */
  async remove(keys: string[]) {
    if (!this.client) return;
    for (const key of keys) {
      try {
        await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
      } catch (error) {
        this.logger.warn(`No se pudo borrar ${key}: ${String(error)}`);
      }
    }
  }

  url(key: string) {
    return `${this.publicUrl}/${key}`;
  }
}
