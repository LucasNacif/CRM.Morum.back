import { randomUUID } from 'node:crypto';
import { BadRequestException, Body, Controller, Delete, HttpCode, Injectable, NotFoundException, Param, ParseUUIDPipe, Patch, Post } from '@nestjs/common';
import { Transform } from 'class-transformer';
import { IsBoolean, IsOptional, IsString, Matches, MaxLength } from 'class-validator';
import { BusinessId } from '../common/business.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { StorageService } from '../storage/storage.service.js';

/** Cada foto se guarda en dos tamaños con el mismo nombre base. */
export const largeKey = (key: string) => `${key}.jpg`;
export const thumbKey = (key: string) => `${key}-thumb.jpg`;

const MAX_IMAGES_PER_PRODUCT = 12;

export class SaveImageDto {
  /** Nombre base devuelto al pedir la subida. */
  @IsString()
  @Matches(/^[a-z0-9-]+\/[0-9a-f-]{36}\/[0-9a-f-]{36}$/, { message: 'Foto inválida' })
  key: string;

  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() || undefined : value))
  @IsString()
  @MaxLength(40)
  color?: string;
}

export class UpdateImageDto {
  /** Color al que corresponde. `null` = todas las variantes. */
  @IsOptional()
  @Transform(({ value }) => (value === '' ? null : value))
  @IsString()
  @MaxLength(40)
  color?: string | null;

  /** Pasarla a foto principal. */
  @IsOptional()
  @IsBoolean()
  main?: boolean;
}

@Injectable()
export class ProductImagesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
  ) {}

  /** Agrega las URLs públicas a las fotos guardadas. */
  present<T extends { key: string }>(image: T) {
    return { ...image, url: this.storage.url(largeKey(image.key)), thumbUrl: this.storage.url(thumbKey(image.key)) };
  }

  private async assertProduct(businessId: string, productId: string) {
    const product = await this.prisma.product.findFirst({ where: { id: productId, businessId }, select: { id: true } });
    if (!product) throw new NotFoundException('No se encontró el producto');
  }

  private async getImage(businessId: string, id: string) {
    const image = await this.prisma.productImage.findFirst({ where: { id, product: { businessId } } });
    if (!image) throw new NotFoundException('No se encontró la foto');
    return image;
  }

  /** Firma la subida de una foto: el navegador sube directo a R2 la versión grande y la miniatura. */
  async requestUpload(businessId: string, productId: string) {
    await this.assertProduct(businessId, productId);
    const count = await this.prisma.productImage.count({ where: { productId } });
    if (count >= MAX_IMAGES_PER_PRODUCT) throw new BadRequestException(`Máximo ${MAX_IMAGES_PER_PRODUCT} fotos por producto`);
    const key = `${businessId}/${productId}/${randomUUID()}`;
    const [large, thumb] = await Promise.all([
      this.storage.presignUpload(largeKey(key), 'image/jpeg'),
      this.storage.presignUpload(thumbKey(key), 'image/jpeg'),
    ]);
    return { key, uploads: { large, thumb } };
  }

  /** Registra la foto una vez subida. Verifica que los dos archivos existan de verdad. */
  async save(businessId: string, productId: string, dto: SaveImageDto) {
    await this.assertProduct(businessId, productId);
    if (!dto.key.startsWith(`${businessId}/${productId}/`)) throw new BadRequestException('Foto inválida');
    const [large, thumb] = await Promise.all([this.storage.exists(largeKey(dto.key)), this.storage.exists(thumbKey(dto.key))]);
    if (!large || !thumb) throw new BadRequestException('La foto no terminó de subirse. Probá de nuevo');
    const last = await this.prisma.productImage.aggregate({ where: { productId }, _max: { position: true } });
    const image = await this.prisma.productImage.create({
      data: { productId, key: dto.key, color: dto.color, position: (last._max.position ?? -1) + 1 },
    });
    return this.present(image);
  }

  async update(businessId: string, id: string, dto: UpdateImageDto) {
    const image = await this.getImage(businessId, id);
    let position = image.position;
    if (dto.main) {
      const first = await this.prisma.productImage.aggregate({ where: { productId: image.productId }, _min: { position: true } });
      position = Math.min(first._min.position ?? 0, image.position) - 1;
    }
    const updated = await this.prisma.productImage.update({
      where: { id },
      data: { color: dto.color === undefined ? undefined : dto.color, position },
    });
    return this.present(updated);
  }

  async remove(businessId: string, id: string) {
    const image = await this.getImage(businessId, id);
    await this.prisma.productImage.delete({ where: { id } });
    await this.storage.remove([largeKey(image.key), thumbKey(image.key)]);
  }

  /** Borra los archivos de fotos que ya se quitaron de la base (al eliminar un producto). */
  removeFiles(keys: string[]) {
    return this.storage.remove(keys.flatMap((key) => [largeKey(key), thumbKey(key)]));
  }
}

@Controller('products')
export class ProductImagesController {
  constructor(private readonly images: ProductImagesService) {}

  @HttpCode(200)
  @Post(':id/images/upload')
  requestUpload(@BusinessId() businessId: string, @Param('id', ParseUUIDPipe) id: string) {
    return this.images.requestUpload(businessId, id);
  }

  @Post(':id/images')
  save(@BusinessId() businessId: string, @Param('id', ParseUUIDPipe) id: string, @Body() dto: SaveImageDto) {
    return this.images.save(businessId, id, dto);
  }

  @Patch('images/:imageId')
  update(@BusinessId() businessId: string, @Param('imageId', ParseUUIDPipe) imageId: string, @Body() dto: UpdateImageDto) {
    return this.images.update(businessId, imageId, dto);
  }

  @HttpCode(204)
  @Delete('images/:imageId')
  async remove(@BusinessId() businessId: string, @Param('imageId', ParseUUIDPipe) imageId: string) {
    await this.images.remove(businessId, imageId);
  }
}
