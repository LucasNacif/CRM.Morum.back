import { Global, Module } from '@nestjs/common';
import { StockController } from './stock.controller.js';
import { StockService } from './stock.service.js';

@Global()
@Module({
  controllers: [StockController],
  providers: [StockService],
  exports: [StockService],
})
export class StockModule {}
