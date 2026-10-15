import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { AppController } from './app.controller.js';
import { AuthModule } from './auth/auth.module.js';
import { BusinessGuard } from './common/business.js';
import { CategoriesController } from './categories/categories.controller.js';
import { LabelsController, LabelsService } from './labels/labels.controller.js';
import { PrismaModule } from './prisma/prisma.module.js';
import { ProductsController, VariantsController } from './products/products.controller.js';
import { ProductImagesController, ProductImagesService } from './products/images.js';
import { ProductsService } from './products/products.service.js';
import { StorageService } from './storage/storage.service.js';
import { PurchasesController, PurchasesService } from './purchases/purchases.controller.js';
import { ReportsController, ReportsService } from './reports/reports.controller.js';
import { SettingsController } from './settings/settings.controller.js';
import { UsersController } from './users/users.controller.js';
import { SalesController, SalesService } from './sales/sales.controller.js';
import { StockModule } from './stock/stock.module.js';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    ThrottlerModule.forRoot([{ ttl: 60_000, limit: 300 }]),
    PrismaModule,
    AuthModule,
    StockModule,
  ],
  controllers: [
    AppController,
    CategoriesController,
    ProductsController,
    VariantsController,
    ProductImagesController,
    PurchasesController,
    SalesController,
    LabelsController,
    ReportsController,
    SettingsController,
    UsersController,
  ],
  providers: [
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: BusinessGuard },
    ProductsService,
    ProductImagesService,
    StorageService,
    PurchasesService,
    SalesService,
    LabelsService,
    ReportsService,
  ],
})
export class AppModule {}
