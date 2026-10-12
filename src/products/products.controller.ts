import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { CurrentUser, type AuthUser } from '../common/decorators.js';
import {
  CreateProductDto,
  CreateVariantDto,
  ProductsQueryDto,
  UpdateProductDto,
  UpdateVariantDto,
  VariantsQueryDto,
} from './products.dto.js';
import { ProductsService } from './products.service.js';

@Controller('products')
export class ProductsController {
  constructor(private readonly products: ProductsService) {}

  @Get()
  list(@Query() q: ProductsQueryDto) {
    return this.products.list(q);
  }

  @Get(':id')
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.products.get(id);
  }

  @Post()
  create(@Body() dto: CreateProductDto, @CurrentUser() user: AuthUser) {
    return this.products.create(dto, user.id);
  }

  @Patch(':id')
  update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateProductDto) {
    return this.products.update(id, dto);
  }

  @Delete(':id')
  remove(@Param('id', ParseUUIDPipe) id: string) {
    return this.products.remove(id);
  }

  @Post(':id/variants')
  addVariant(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreateVariantDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.products.addVariant(id, dto, user.id);
  }
}

@Controller('variants')
export class VariantsController {
  constructor(private readonly products: ProductsService) {}

  @Get()
  list(@Query() q: VariantsQueryDto) {
    return this.products.listVariants(q);
  }

  @Get('lookup')
  lookup(@Query('code') code?: string) {
    if (!code?.trim()) throw new BadRequestException('Falta el código a buscar');
    return this.products.lookup(code);
  }

  @Patch(':id')
  update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateVariantDto) {
    return this.products.updateVariant(id, dto);
  }

  @Delete(':id')
  remove(@Param('id', ParseUUIDPipe) id: string) {
    return this.products.removeVariant(id);
  }
}
