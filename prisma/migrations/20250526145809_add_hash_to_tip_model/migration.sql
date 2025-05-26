/*
  Warnings:

  - You are about to drop the column `txHash` on the `Tip` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "Tip" DROP COLUMN "txHash",
ADD COLUMN     "hash" TEXT;
