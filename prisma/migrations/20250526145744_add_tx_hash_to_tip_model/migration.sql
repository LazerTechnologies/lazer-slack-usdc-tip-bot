/*
  Warnings:

  - You are about to drop the column `hash` on the `Tip` table. All the data in the column will be lost.

*/
-- DropIndex
DROP INDEX "Tip_hash_key";

-- AlterTable
ALTER TABLE "Tip" DROP COLUMN "hash",
ADD COLUMN     "txHash" TEXT;
