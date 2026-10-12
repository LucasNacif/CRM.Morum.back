/*
  Warnings:

  - You are about to drop the column `supplierId` on the `Purchase` table. All the data in the column will be lost.
  - You are about to drop the `Supplier` table. If the table is not empty, all the data it contains will be lost.

*/
-- DropForeignKey
ALTER TABLE "Purchase" DROP CONSTRAINT "Purchase_supplierId_fkey";

-- AlterTable
ALTER TABLE "Purchase" DROP COLUMN "supplierId";

-- DropTable
DROP TABLE "Supplier";
