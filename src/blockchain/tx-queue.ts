import PQueue from "p-queue";

// Global queue for blockchain transactions
export const blockchainQueue = new PQueue({ concurrency: 1})