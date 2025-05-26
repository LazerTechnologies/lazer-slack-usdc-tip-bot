/*
  Warnings:

  - A unique constraint covering the columns `[hash]` on the table `Tip` will be added. If there are existing duplicate values, this will fail.

*/
-- AlterTable
ALTER TABLE "Tip" ADD COLUMN     "hash" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "Tip_hash_key" ON "Tip"("hash");
