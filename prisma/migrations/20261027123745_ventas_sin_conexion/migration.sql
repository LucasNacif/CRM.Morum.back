-- AlterTable
ALTER TABLE "Sale" ADD COLUMN     "offline" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "oversold" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "oversoldReviewedAt" TIMESTAMP(3);
