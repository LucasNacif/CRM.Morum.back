-- Separa los datos en dos negocios (Morum y Clarus), quita las compras y agrega ventas con seña.
-- Todo lo que existe hasta ahora pasa a pertenecer a Morum.

-- Enums
CREATE TYPE "Delivery" AS ENUM ('DELIVERED', 'RESERVED');
ALTER TYPE "MovementType" ADD VALUE 'RESTOCK';

-- Negocios
CREATE TABLE "Business" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "lastSaleNumber" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Business_pkey" PRIMARY KEY ("id")
);
INSERT INTO "Business" ("id", "name") VALUES ('morum', 'Morum'), ('clarus', 'Clarus');

-- Fuera las compras. Los movimientos que generaron conservan su tipo (PURCHASE).
ALTER TABLE "StockMovement" DROP CONSTRAINT "StockMovement_purchaseId_fkey";
ALTER TABLE "StockMovement" DROP COLUMN "purchaseId";
DROP TABLE "PurchaseItem";
DROP TABLE "Purchase";

-- Categorías: únicas por negocio
DROP INDEX "Category_name_key";
ALTER TABLE "Category" ADD COLUMN "businessId" TEXT;
UPDATE "Category" SET "businessId" = 'morum';
ALTER TABLE "Category" ALTER COLUMN "businessId" SET NOT NULL;
CREATE UNIQUE INDEX "Category_businessId_name_key" ON "Category"("businessId", "name");
ALTER TABLE "Category" ADD CONSTRAINT "Category_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Clarus arranca con las mismas categorías base
INSERT INTO "Category" ("id", "name", "businessId")
SELECT gen_random_uuid()::text, "name", 'clarus'
FROM "Category"
WHERE "businessId" = 'morum' AND "name" IN ('Remeras', 'Pantalones', 'Buzos', 'Camperas', 'Vestidos', 'Accesorios');

-- Productos
DROP INDEX "Product_name_idx";
ALTER TABLE "Product" ADD COLUMN "businessId" TEXT;
UPDATE "Product" SET "businessId" = 'morum';
ALTER TABLE "Product" ALTER COLUMN "businessId" SET NOT NULL;
CREATE INDEX "Product_businessId_name_idx" ON "Product"("businessId", "name");
ALTER TABLE "Product" ADD CONSTRAINT "Product_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Ventas: numeración por negocio y datos de la seña
DROP INDEX "Sale_date_idx";
DROP INDEX "Sale_number_key";
ALTER TABLE "Sale"
    ADD COLUMN "businessId" TEXT,
    ADD COLUMN "customerPhone" TEXT,
    ADD COLUMN "delivery" "Delivery" NOT NULL DEFAULT 'DELIVERED',
    ADD COLUMN "dueDate" TIMESTAMP(3),
    ADD COLUMN "paidAmount" DECIMAL(12,2) NOT NULL DEFAULT 0,
    ALTER COLUMN "number" DROP DEFAULT;
DROP SEQUENCE "Sale_number_seq";
-- Las ventas existentes se cobraron completas.
UPDATE "Sale" SET "businessId" = 'morum', "paidAmount" = "total";
ALTER TABLE "Sale" ALTER COLUMN "businessId" SET NOT NULL;
CREATE UNIQUE INDEX "Sale_businessId_number_key" ON "Sale"("businessId", "number");
CREATE INDEX "Sale_businessId_date_idx" ON "Sale"("businessId", "date");
CREATE INDEX "Sale_businessId_dueDate_idx" ON "Sale"("businessId", "dueDate");
ALTER TABLE "Sale" ADD CONSTRAINT "Sale_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

UPDATE "Business" SET "lastSaleNumber" = COALESCE((SELECT MAX("number") FROM "Sale" WHERE "businessId" = 'morum'), 0)
WHERE "id" = 'morum';

-- Pagos: cada venta existente tiene un único pago por el total
CREATE TABLE "Payment" (
    "id" TEXT NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "method" "PaymentMethod" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "saleId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    CONSTRAINT "Payment_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "Payment_saleId_idx" ON "Payment"("saleId");
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_saleId_fkey" FOREIGN KEY ("saleId") REFERENCES "Sale"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
INSERT INTO "Payment" ("id", "amount", "method", "createdAt", "saleId", "userId")
SELECT gen_random_uuid()::text, "total", "paymentMethod", "date", "id", "userId" FROM "Sale";

-- Configuración: una fila por negocio
ALTER TABLE "Settings" ADD COLUMN "businessId" TEXT,
    ADD COLUMN "dueAlertDays" INTEGER NOT NULL DEFAULT 3,
    ADD COLUMN "roundTo" INTEGER NOT NULL DEFAULT 0;
UPDATE "Settings" SET "businessId" = 'morum' WHERE "id" = 1;
DELETE FROM "Settings" WHERE "businessId" IS NULL;
ALTER TABLE "Settings" DROP CONSTRAINT "Settings_pkey", DROP COLUMN "id";
ALTER TABLE "Settings" ALTER COLUMN "businessId" SET NOT NULL;
ALTER TABLE "Settings" ADD CONSTRAINT "Settings_pkey" PRIMARY KEY ("businessId");
ALTER TABLE "Settings" ADD CONSTRAINT "Settings_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
INSERT INTO "Settings" ("businessId", "updatedAt") VALUES ('morum', CURRENT_TIMESTAMP), ('clarus', CURRENT_TIMESTAMP)
ON CONFLICT ("businessId") DO NOTHING;
