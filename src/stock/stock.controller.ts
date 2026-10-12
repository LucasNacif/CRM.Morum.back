import { Body, Controller, Get, Post, Query } from '@nestjs/common';
import { CurrentUser, type AuthUser } from '../common/decorators.js';
import { AdjustStockDto, MovementsQueryDto } from './stock.dto.js';
import { StockService } from './stock.service.js';

@Controller('stock')
export class StockController {
  constructor(private readonly stock: StockService) {}

  @Get('movements')
  movements(@Query() q: MovementsQueryDto) {
    return this.stock.listMovements(q);
  }

  @Post('adjustments')
  adjust(@Body() dto: AdjustStockDto, @CurrentUser() user: AuthUser) {
    return this.stock.adjust(dto, user.id);
  }
}
