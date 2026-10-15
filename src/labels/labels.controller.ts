import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Injectable,
  Post,
  StreamableFile,
} from '@nestjs/common';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsIn,
  IsInt,
  IsOptional,
  IsUUID,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';
import bwipjs from 'bwip-js/node';
import PDFDocument from 'pdfkit';
import { BusinessId } from '../common/business.js';
import { PrismaService } from '../prisma/prisma.service.js';

const MM = 72 / 25.4;
const MAX_LABELS = 2000;

/** Planchas autoadhesivas A4. Medidas en milímetros. */
export const LAYOUTS = {
  'a4-24': { name: '24 por hoja · 70 × 37 mm', cols: 3, rows: 8, width: 70, height: 37, marginLeft: 0, marginTop: 0.5, gapX: 0, gapY: 0 },
  'a4-21': { name: '21 por hoja · 63,5 × 38,1 mm', cols: 3, rows: 7, width: 63.5, height: 38.1, marginLeft: 7.2, marginTop: 15.1, gapX: 2.5, gapY: 0 },
  'a4-40': { name: '40 por hoja · 52,5 × 29,7 mm', cols: 4, rows: 10, width: 52.5, height: 29.7, marginLeft: 0, marginTop: 0, gapX: 0, gapY: 0 },
  'a4-65': { name: '65 por hoja · 38,1 × 21,2 mm', cols: 5, rows: 13, width: 38.1, height: 21.2, marginLeft: 4.75, marginTop: 10.7, gapX: 2.5, gapY: 0 },
} as const;

type LayoutId = keyof typeof LAYOUTS;

export class LabelItemDto {
  @IsUUID()
  variantId: string;

  @IsInt()
  @Min(1)
  @Max(500)
  copies: number;
}

export class LabelsPdfDto {
  @IsIn(Object.keys(LAYOUTS))
  layout: LayoutId;

  /** Posición (desde 1) donde empezar en la primera hoja, para aprovechar planchas ya usadas. */
  @IsOptional()
  @IsInt()
  @Min(1)
  startAt?: number;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(500)
  @ValidateNested({ each: true })
  @Type(() => LabelItemDto)
  items: LabelItemDto[];
}

interface Label {
  name: string;
  /** Color y talle, para distinguir variantes sin leer el código. */
  detail: string;
  barcode: string;
}

@Injectable()
export class LabelsService {
  constructor(private readonly prisma: PrismaService) {}

  async pdf(businessId: string, dto: LabelsPdfDto): Promise<Buffer> {
    const layout = LAYOUTS[dto.layout];
    const perPage = layout.cols * layout.rows;
    const startAt = dto.startAt ?? 1;
    if (startAt > perPage) {
      throw new BadRequestException(`La plancha tiene ${perPage} etiquetas: la posición inicial no puede ser ${startAt}`);
    }
    const totalLabels = dto.items.reduce((sum, item) => sum + item.copies, 0);
    if (totalLabels > MAX_LABELS) {
      throw new BadRequestException(`Máximo ${MAX_LABELS} etiquetas por PDF (se pidieron ${totalLabels})`);
    }

    const variants = await this.prisma.variant.findMany({
      where: { id: { in: dto.items.map((item) => item.variantId) }, product: { businessId } },
      select: { id: true, size: true, color: true, barcode: true, product: { select: { name: true } } },
    });
    const byId = new Map(variants.map((variant) => [variant.id, variant]));

    const labels: Label[] = [];
    for (const item of dto.items) {
      const variant = byId.get(item.variantId);
      if (!variant) throw new BadRequestException('Una de las variantes ya no existe');
      const label = {
        name: variant.product.name,
        detail: `${variant.color} ${variant.size}`,
        barcode: variant.barcode,
      };
      for (let i = 0; i < item.copies; i++) labels.push(label);
    }

    const images = new Map<string, Buffer>();
    for (const { barcode } of labels) {
      if (!images.has(barcode)) {
        images.set(
          barcode,
          await bwipjs.toBuffer({ bcid: 'code128', text: barcode, scale: 4, height: 9, includetext: false }),
        );
      }
    }

    const doc = new PDFDocument({ size: 'A4', margin: 0, autoFirstPage: false });
    const chunks: Buffer[] = [];
    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    const finished = new Promise<void>((resolve, reject) => {
      doc.on('end', resolve);
      doc.on('error', reject);
    });

    labels.forEach((label, index) => {
      const slot = (index + startAt - 1) % perPage;
      if (index === 0 || slot === 0) doc.addPage();
      const col = slot % layout.cols;
      const row = Math.floor(slot / layout.cols);
      const x = (layout.marginLeft + col * (layout.width + layout.gapX)) * MM;
      const y = (layout.marginTop + row * (layout.height + layout.gapY)) * MM;
      this.drawLabel(doc, label, images.get(label.barcode)!, x, y, layout.width * MM, layout.height * MM);
    });

    doc.end();
    await finished;
    return Buffer.concat(chunks);
  }

  private drawLabel(
    doc: PDFKit.PDFDocument,
    label: Label,
    image: Buffer,
    x: number,
    y: number,
    width: number,
    height: number,
  ) {
    const small = height < 25 * MM;
    const fontSize = small ? 5.5 : 7.5;
    const padX = 3 * MM;
    const padY = (small ? 1.5 : 3) * MM;
    const lineHeight = fontSize * 1.25;
    const innerWidth = width - padX * 2;
    const textOptions = { width: innerWidth, height: lineHeight, align: 'center', lineBreak: false, ellipsis: true } as const;

    doc.font('Helvetica-Bold').fontSize(fontSize).text(label.name, x + padX, y + padY, textOptions);

    const barcodeTop = y + padY + lineHeight + 1;
    const barcodeHeight = height - padY * 2 - lineHeight * 2 - 2;
    // Más angosto que la etiqueta: el lector necesita margen en blanco a cada lado del código.
    const barcodeWidth = Math.min(innerWidth - 4 * MM, 45 * MM);
    doc.image(image, x + (width - barcodeWidth) / 2, barcodeTop, {
      fit: [barcodeWidth, barcodeHeight],
      align: 'center',
      valign: 'center',
    });

    doc
      .font('Helvetica')
      .fontSize(fontSize)
      .text(`${label.barcode} · ${label.detail}`, x + padX, y + height - padY - lineHeight + 1, textOptions);
  }
}

@Controller('labels')
export class LabelsController {
  constructor(private readonly labels: LabelsService) {}

  @Get('layouts')
  layouts() {
    return Object.entries(LAYOUTS).map(([id, layout]) => ({
      id,
      name: layout.name,
      perPage: layout.cols * layout.rows,
    }));
  }

  @HttpCode(200)
  @Post('pdf')
  async pdf(@BusinessId() businessId: string, @Body() dto: LabelsPdfDto) {
    return new StreamableFile(await this.labels.pdf(businessId, dto), {
      type: 'application/pdf',
      disposition: 'inline; filename="etiquetas.pdf"',
    });
  }
}
