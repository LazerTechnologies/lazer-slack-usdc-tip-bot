import {
	adminAccount,
	getUSDCBalance,
	getUserDepositAccount,
	publicClient,
	sweep,
} from "../blockchain/wallet";
import db from "../db/prismaClient";
import app from "./slackClient";
import { formatUnits, maxInt256, parseUnits, type Address } from "viem";
import { blockchainQueue } from "../blockchain/tx-queue";

app.message(/^update$/i, async ({ message, say }) => {
	if (!("user" in message)) return;
	const slackId = message.user as string;

	const user = await db.user.upsert({
		where: { slackId },
		create: { slackId },
		update: {},
	});
    await say(`Checking for deposits for <@${slackId}>...`);
	if (user.depositAddress === null) {
		const depositAccount = getUserDepositAccount(user.id);
		await db.user.update({
			where: { id: user.id },
			data: { depositAddress: depositAccount.address },
		});
		await say(
			`Your deposit address has been set to: \`${depositAccount.address}\``,
		);
		return;
	}

	const balance = await getUSDCBalance(user.depositAddress as Address);
	if (balance > 0n) {
		blockchainQueue.add(async () => {
			console.log(
				`[UPDATE] Processing deposit for user ${slackId} (${user.id}) to address ${user.depositAddress}`,
			);
			const hash = await sweep({
				fromIndex: user.id,
				to: adminAccount.address as `0x${string}`,
				amount: balance,
				validAfter: 0n,
				validBefore: maxInt256,
			});

            await publicClient.waitForTransactionReceipt({
                hash,
            })

            await db.user.update({
                where: { id: user.id },
                data: { extraBalance: { increment: formatUnits(balance, 6) } },
            })

            await say(`Your deposit of ${formatUnits(balance, 6)} USDC has been processed! https://basescan.org/tx/${hash}`);
		});
	}
});
