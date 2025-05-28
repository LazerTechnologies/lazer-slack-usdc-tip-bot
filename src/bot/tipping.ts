import app from "./slackClient";
import prisma from "../db/prismaClient";
import {
	adminAccount,
	getUSDCBalance,
	USDCContract,
	publicClient,
} from "../blockchain/wallet";
import { Decimal } from "@prisma/client/runtime/library";
import { blockchainQueue } from "../blockchain/tx-queue";
import type { Prisma, User, Tip } from "../generated";
import type { WebClient } from "@slack/web-api";

const TIP_AMOUNT = new Decimal(0.01);
const DAILY_TIP_LIMIT = 10;

// Helper to send a DM to a user (for tip notifications and critical alerts only)
async function sendDM(client: WebClient, userId: string, text: string) {
	const dm = await client.conversations.open({ users: userId });
	if (!dm.channel) {
		console.error("[TIP] Failed to open DM channel", { userId, dm });
		return;
	}
	const dmChannel = dm.channel.id ? dm.channel.id : null;
	if (dmChannel) {
		await client.chat.postMessage({ channel: dmChannel, text });
		console.log("[TIP] Sent DM", { userId, dmChannel });
	} else {
		console.error("[TIP] Failed to open DM channel", { userId, dm });
	}
}

function isSelfTip(tipperId: string, recipientId: string) {
	return tipperId === recipientId;
}

async function isDuplicateTip(
	prismaTx: Prisma.TransactionClient,
	tipperId: string,
	recipientId: string,
	messageTs: string,
): Promise<Tip | null> {
	return await prismaTx.tip.findFirst({
		where: {
			fromUser: { slackId: tipperId },
			toUser: { slackId: recipientId },
			messageTs,
		},
	});
}

async function getOrCreateUser(
	prismaTx: Prisma.TransactionClient,
	slackId: string,
): Promise<User> {
	return await prismaTx.user.upsert({
		where: { slackId },
		update: {},
		create: { slackId },
	});
}

async function resetDailyTipIfNeeded(
	prismaTx: Prisma.TransactionClient,
	user: User,
): Promise<number> {
	const today = new Date();
	today.setHours(0, 0, 0, 0);
	if (!user.lastTipDate || user.lastTipDate < today) {
		await prismaTx.user.update({
			where: { id: user.id },
			data: { tipsGivenToday: 0, lastTipDate: new Date() },
		});
		return 0;
	}
	return user.tipsGivenToday;
}

function hasTipQuota(tipsGivenToday: number, extraBalance: Prisma.Decimal) {
	const hasFreeTips = tipsGivenToday < DAILY_TIP_LIMIT;
	const hasExtraBalance = extraBalance?.gte(TIP_AMOUNT);
	return { hasFreeTips, hasExtraBalance };
}

async function deductExtraBalance(
	prismaTx: Prisma.TransactionClient,
	user: User,
) {
	await prismaTx.user.update({
		where: { id: user.id },
		data: { extraBalance: { decrement: TIP_AMOUNT } },
	});
}

interface TipContext {
	prismaTx: Prisma.TransactionClient;
	client: WebClient;
	tipper: User;
	recipient: User;
	messageTs: string;
	channelId: string;
}

async function processBlockchainTip({
	prismaTx,
	client,
	tipper,
	recipient,
	messageTs,
	channelId,
}: TipContext) {
	const tip = await prismaTx.tip.create({
		data: {
			fromUserId: tipper.id,
			toUserId: recipient.id,
			amount: TIP_AMOUNT,
			messageTs,
			channelId,
			hash: null,
		},
	});
	await prismaTx.user.update({
		where: { id: tipper.id },
		data: {
			tipsGivenToday: { increment: 1 },
			lastTipDate: new Date(),
		},
	});
	blockchainQueue.add(async () => {
		try {
			const amount = BigInt(TIP_AMOUNT.mul(1e6).toFixed(0));
			const to = recipient.ethAddress as `0x${string}`;
			const adminBalance = await getUSDCBalance(adminAccount.address);
			if (adminBalance < amount) {
				await sendDM(
					client,
					tipper.slackId,
					`You tipped <@${recipient.slackId}> 0.01 USDC! (Insufficient on-chain balance, credited to internal balance)`,
				);
				await prisma.user.update({
					where: { id: recipient.id },
					data: { balance: { increment: TIP_AMOUNT } },
				});
				return;
			}
			const hash = await USDCContract.write.transfer([to, amount]);
			await publicClient.waitForTransactionReceipt({ hash, confirmations: 1 });
			await prisma.tip.update({
				where: { id: tip.id },
				data: { hash },
			});
			const basecanUrl = `https://basescan.org/tx/${hash}`;

			// Calculate recipient's free tips left today (on-chain tips are always after increment, so +1)
			const DAILY_TIP_LIMIT = 10;
			const tipsLeft = DAILY_TIP_LIMIT - ((recipient.tipsGivenToday ?? 0) + 1);
			await sendDM(
				client,
				recipient.slackId,
				`🎉 You just received a tip from <@${tipper.slackId}>!\nAmount: 0.01 USDC\nView transaction: ${basecanUrl}\nYou have ${tipsLeft} free tips left to give today.\nCheck your Home tab for your updated balance.`,
			);
		} catch (err) {
			await sendDM(
				client,
				tipper.slackId,
				`Tip failed to send on-chain: ${err}`,
			);
		}
	});
}

// In processInternalTip, only DM the recipient for successful tips
async function processInternalTip({
	prismaTx,
	client,
	tipper,
	recipient,
	messageTs,
	channelId,
}: TipContext) {
	await prismaTx.user.update({
		where: { id: recipient.id },
		data: { balance: { increment: TIP_AMOUNT } },
	});
	await prismaTx.tip.create({
		data: {
			fromUserId: tipper.id,
			toUserId: recipient.id,
			amount: TIP_AMOUNT,
			messageTs,
			channelId,
		},
	});
	await prismaTx.user.update({
		where: { id: tipper.id },
		data: {
			tipsGivenToday: { increment: 1 },
			lastTipDate: new Date(),
		},
	});

	// Calculate recipient's free tips left today
	const DAILY_TIP_LIMIT = 10;
	const tipsLeft = DAILY_TIP_LIMIT - ((recipient.tipsGivenToday ?? 0) + 1);
	await sendDM(
		client,
		recipient.slackId,
		`🎉 You just received a tip from <@${tipper.slackId}>!\nAmount: 0.01 USDC\nYou have ${tipsLeft} free tips left to give today.\nCheck your Home tab for your updated balance.`,
	);
}

// --- Main Event Handler ---

app.event("reaction_added", async ({ event, client }) => {
	if (
		!event.reaction ||
		(event.reaction !== "dollar" && event.reaction !== "$")
	)
		return;
	const tipperSlackId = event.user;
	const messageTs = event.item.ts;
	const channelId = event.item.channel;
	const recipientSlackId = event.item_user;
	if (!recipientSlackId) return;

	await prisma.$transaction(async (prismaTx: Prisma.TransactionClient) => {
		if (await isSelfTip(tipperSlackId, recipientSlackId)) {
			await sendDM(client, tipperSlackId, "You can't tip yourself!");
			return;
		}
		if (
			await isDuplicateTip(prismaTx, tipperSlackId, recipientSlackId, messageTs)
		) {
			await sendDM(
				client,
				tipperSlackId,
				`You already tipped <@${recipientSlackId}> for this post.`,
			);
			return;
		}
		const tipper = await getOrCreateUser(prismaTx, tipperSlackId);
		const tipsGivenToday = await resetDailyTipIfNeeded(prismaTx, tipper);
		const { hasFreeTips, hasExtraBalance } = hasTipQuota(
			tipsGivenToday,
			tipper.extraBalance,
		);
		if (!hasFreeTips && !hasExtraBalance) {
			await sendDM(
				client,
				tipperSlackId,
				"You've reached your daily free tip limit and have no extra balance left!",
			);
			return;
		}
		if (!hasFreeTips && hasExtraBalance) {
			await deductExtraBalance(prismaTx, tipper);
		}
		const recipient = await getOrCreateUser(prismaTx, recipientSlackId);
		if (recipient.ethAddress) {
			await processBlockchainTip({
				prismaTx,
				client,
				tipper,
				recipient,
				messageTs,
				channelId,
			});
		} else {
			await processInternalTip({
				prismaTx,
				client,
				tipper,
				recipient,
				messageTs,
				channelId,
			});
		}
	});
});
