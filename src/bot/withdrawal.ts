import app from "./slackClient";
import prisma from "../db/prismaClient";
import { publicClient, USDCContract } from "../blockchain/wallet";
import { isAddress, parseUnits } from "viem";
import { blockchainQueue } from "../blockchain/tx-queue";

// Listen for a DM with an address (this is the only way to set withdrawal address)
app.message(
	/^(0x[a-fA-F0-9]{40})$/,
	async ({ message, context, say }) => {
		// message.user may not exist on all message event types, so fallback to message['user']
		const slackId = (message as any).user;
		const ethAddress = context.matches[1];
		const isValid = isAddress(ethAddress);

		if (!isValid) {
			await say(
				"Invalid Ethereum address format. Please provide a valid address.",
			);
			return;
		}
		if (!slackId) {
			await say("Could not determine your Slack user ID.");
			return;
		}
    const user = await prisma.user.findUnique({
      where: { slackId },
    });
		await prisma.user.update({
			where: { slackId },
			data: { ethAddress },
		});
    const extra = user?.balance.greaterThan(0)
      ? ` You have ${user.balance.toString()} USDC available for withdrawal.`
      : "";
		await say(`Your withdrawal address has been set!${extra}`);


		if (user?.balance.greaterThan(0)) {
			blockchainQueue.add(async () => {
				console.log(
					`[WITHDRAWAL] Processing accrued withdrawal for user ${slackId} (${user.id}) to address ${ethAddress}`,
				);
				const hash = await USDCContract.write.transfer([
					ethAddress,
					parseUnits(user.balance.toString(), 6),
				]);

				await publicClient.waitForTransactionReceipt({
					hash,
				});

        await prisma.user.update({
          where: { slackId },
          data: { balance: { set: 0 } },
        });

        await say(`Your withdrawal of ${user.balance.toString()} USDC has been processed!  https://basescan.org/tx/${hash}`);

				console.log(
					`[WITHDRAWAL] Withdrawal confirmed for user ${slackId} (${user.id})`,
				);
			});
		}
	},
);

// Helper to notify user to set withdrawal address, but only once per day
export async function notifySetWithdrawal(slackId: string, client: any) {
	// Use a key in the user's record to track last notification date
	const user = await prisma.user.findUnique({ where: { slackId } });
	const today = new Date();
	today.setHours(0, 0, 0, 0);
	// We'll use lastTipDate as a proxy for last notification (or add a new field if you want)
	if (user?.lastTipDate && user.lastTipDate >= today) {
		// Already notified today
		return;
	}
	await client.chat.postMessage({
		channel: slackId,
		text: "You received a tip! To withdraw your USDC, DM me a valid Ethereum address",
	});
	// Update lastTipDate to today to avoid duplicate notifications
	await prisma.user.update({
		where: { slackId },
		data: { lastTipDate: new Date() },
	});
}
