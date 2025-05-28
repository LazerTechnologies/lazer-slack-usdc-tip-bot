-- CreateTable
CREATE TABLE "Settings" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "dailyFreeTipAmount" DECIMAL(65,30) NOT NULL DEFAULT 1,
    "tipAmount" DECIMAL(65,30) NOT NULL DEFAULT 1,
    "adminSlackIds" TEXT[],
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Settings_pkey" PRIMARY KEY ("id")
);
