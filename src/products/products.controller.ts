import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { BusinessId } from '../common/business.js';
import { CurrentUser, type AuthUser } from '../common/decorators.js';
import {
  BulkPricesDto,
  CreateProductDto,
  CreateVariantDto,
  ProductsQueryDto,
  SetPriceDto,
  UpdateProductDto,
  UpdateVariantDto,
  VariantsQueryDto,
} from './products.dto.js';
import { ProductsService } from './products.service.js';

@Controller('products')
export class ProductsController {
  constructor(private readonly products: ProductsService) {}

  @Get()
  list(@BusinessId() businessId: string, @Query() q: ProductsQueryDto) {
    return this.products.list(businessId, q);
  }

  @HttpCode(200)
  @Post('prices/bulk')
  bulkPrices(@BusinessId() businessId: string, @Body() dto: BulkPricesDto) {
    return this.products.bulkPrices(businessId, dto);
  }

  @Get(':id')
  get(@BusinessId() businessId: string, @Param('id', ParseUUIDPipe) id: string) {
    return this.products.get(businessId, id);
  }

  @Post()
  create(@BusinessId() businessId: string, @Body() dto: CreateProductDto, @CurrentUser() user: AuthUser) {
    return this.products.create(businessId, dto, user.id);
  }

  @Patch(':id')
  update(@BusinessId() businessId: string, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateProductDto) {
    return this.products.update(businessId, id, dto);
  }

  @HttpCode(200)
  @Post(':id/price')
  setPrice(@BusinessId() businessId: string, @Param('id', ParseUUIDPipe) id: string, @Body() dto: SetPriceDto) {
    return this.products.setPrice(businessId, id, dto.price);
  }

  @Delete(':id')
  remove(@BusinessId() businessId: string, @Param('id', ParseUUIDPipe) id: string) {
    return this.products.remove(businessId, id);
  }

  @Post(':id/variants')
  addVariant(
    @BusinessId() businessId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreateVariantDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.products.addVariant(businessId, id, dto, user.id);
  }
}

@Controller('variants')
export class VariantsController {
  constructor(private readonly products: ProductsService) {}

  @Get()
  list(@BusinessId() businessId: string, @Query() q: VariantsQueryDto) {
    return this.products.listVariants(businessId, q);
  }

  @Get('lookup')
  lookup(@BusinessId() businessId: string, @Query('code') code?: string) {
    if (!code?.trim()) throw new BadRequestException('Falta el código a buscar');
    return this.products.lookup(businessId, code);
  }

  @Patch(':id')
  update(@BusinessId() businessId: string, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateVariantDto) {
    return this.products.updateVariant(businessId, id, dto);
  }

  @Delete(':id')
  remove(@BusinessId() businessId: string, @Param('id', ParseUUIDPipe) id: string) {
    return this.products.removeVariant(businessId, id);
  }
}
