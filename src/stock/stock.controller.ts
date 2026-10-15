import { Body, Controller, Post } from '@nestjs/common';
import { BusinessId } from '../common/business.js';
import { CurrentUser, type AuthUser } from '../common/decorators.js';
import { AdjustStockDto } from './stock.dto.js';
import { StockService } from './stock.service.js';

@Controller('stock')
export class StockController {
  constructor(private readonly stock: StockService) {}

  @Post('adjustments')
  adjust(@BusinessId() businessId: string, @Body() dto: AdjustStockDto, @CurrentUser() user: AuthUser) {
    return this.stock.adjust(businessId, dto, user.id);
  }
}
