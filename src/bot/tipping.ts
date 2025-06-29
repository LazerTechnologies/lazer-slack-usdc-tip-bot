import app from "./slackClient.ts";
import prisma from "../db/prismaClient.ts";
import {
	adminAccount,
	getUSDCBalance,
	USDCContract,
	publicClient,
} from "../blockchain/wallet.ts";
import { Decimal } from "@prisma/client/runtime/library";
import { blockchainQueue } from "../blockchain/tx-queue.ts";
import type { Prisma, User, Tip } from "../generated/index.d.ts";
import type { WebClient } from "@slack/web-api";

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

// Helper to fetch settings from DB
async function getSettings() {
	const settings = await prisma.settings.findUnique({ where: { id: 1 } });
	if (!settings) throw new Error("Settings not found in DB");
	return settings;
}

function hasTipQuota(tipsGivenToday: number, extraBalance: Prisma.Decimal, dailyTipLimit: number, tipAmount: Decimal) {
	const hasFreeTips = tipsGivenToday < dailyTipLimit;
	const hasExtraBalance = extraBalance?.gte(tipAmount);
	return { hasFreeTips, hasExtraBalance };
}

async function deductExtraBalance(
	prismaTx: Prisma.TransactionClient,
	user: User,
	tipAmount: Decimal,
) {
	await prismaTx.user.update({
		where: { id: user.id },
		data: { extraBalance: { decrement: tipAmount } },
	});
}

interface TipContext {
	prismaTx: Prisma.TransactionClient;
	client: WebClient;
	tipper: User;
	recipient: User;
	messageTs: string;
	channelId: string;
	tipAmount: Decimal;
	dailyTipLimit: number;
}

async function processBlockchainTip({
	prismaTx,
	client,
	tipper,
	recipient,
	messageTs,
	channelId,
	tipAmount,
	dailyTipLimit,
}: TipContext) {
	const tip = await prismaTx.tip.create({
		data: {
			fromUserId: tipper.id,
			toUserId: recipient.id,
			amount: tipAmount,
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
		// Get permalink to the original message once at the beginning
		let messageLink = "";
		try {
			const permalink = await client.chat.getPermalink({
				channel: channelId,
				message_ts: messageTs,
			});
			messageLink = permalink.permalink || "";
		} catch (err) {
			console.error("[TIP] Failed to get permalink", { err, channelId, messageTs });
		}

		// Re-fetch tipper to check up-to-date quota and extraBalance
		const latestTipper = await prisma.user.findUnique({ where: { id: tipper.id } });
		if (!latestTipper) {
			await sendDM(client, tipper.slackId, "Tip failed: user not found.");
			return;
		}
		const tipsGivenToday = latestTipper.tipsGivenToday ?? 0;
		const hasFreeTips = tipsGivenToday < dailyTipLimit;
		const hasExtraBalance = latestTipper.extraBalance?.gte(tipAmount);
		if (!hasFreeTips && !hasExtraBalance) {
			await sendDM(client, tipper.slackId, "Tip failed: You've reached your daily free tip limit and have no extra balance left!");
			return;
		}
		if (!hasFreeTips && hasExtraBalance) {
			// Deduct extraBalance atomically
			await prisma.user.update({
				where: { id: tipper.id },
				data: { extraBalance: { decrement: tipAmount } },
			});
		}
		try {
			const amount = BigInt(tipAmount.mul(1e6).toFixed(0));
			const to = recipient.ethAddress as `0x${string}`;
			const adminBalance = await getUSDCBalance(adminAccount.address);
			if (adminBalance < amount) {
				let tipperMsg = `You tipped <@${recipient.slackId}> ${tipAmount.toFixed(2)} USDC! (Insufficient on-chain balance, credited to internal balance)`;
				if (messageLink) {
					tipperMsg += `\nSee the message: ${messageLink}`;
				}
				await sendDM(client, tipper.slackId, tipperMsg);
				
				// Send notification to recipient with link
				let recipientMsg = `🎉 You just received a tip from <@${tipper.slackId}>! (Credited to internal balance)`;
				if (messageLink) {
					recipientMsg += `\nSee the message: ${messageLink}`;
				}
				await sendDM(client, recipient.slackId, recipientMsg);

				await prisma.user.update({
					where: { id: recipient.id },
					data: { balance: { increment: tipAmount } },
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

			// Fetch updated tipper and recipient after DB increments
			const updatedTipper = await prisma.user.findUnique({ where: { id: tipper.id } });
			const updatedRecipient = await prisma.user.findUnique({ where: { id: recipient.id } });

			const tipsLeftRecipient = Math.max(0, dailyTipLimit - (updatedRecipient?.tipsGivenToday ?? 0));
			const extraBalanceRecipient = updatedRecipient?.extraBalance?.toFixed(2) ?? "0.00";
			let recipientMsg = `🎉 You just received a tip from <@${tipper.slackId}>!\nView transaction: ${basecanUrl}`;
			if (messageLink) {
				recipientMsg += `\nSee the message: ${messageLink}`;
			}
			recipientMsg += `\nYou have ${tipsLeftRecipient} free tips left to give today and $${extraBalanceRecipient} extra balance left.`;
			await sendDM(client, recipient.slackId, recipientMsg);

			// DM the tipper with confirmation and block explorer link
			const tipsLeftTipper = Math.max(0, dailyTipLimit - (updatedTipper?.tipsGivenToday ?? 0));
			const extraBalanceTipper = updatedTipper?.extraBalance?.toFixed(2) ?? "0.00";
			let tipperMsg = `✅ You tipped <@${recipient.slackId}> ${tipAmount.toFixed(2)} USDC!\nView transaction: ${basecanUrl}`;
			if (messageLink) {
				tipperMsg += `\nSee the message: ${messageLink}`;
			}
			tipperMsg += `\nYou have ${tipsLeftTipper} free tips left today and $${extraBalanceTipper} extra balance left.`;
			await sendDM(client, tipper.slackId, tipperMsg);
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
	tipAmount,
	dailyTipLimit,
}: TipContext) {
	await prismaTx.user.update({
		where: { id: recipient.id },
		data: { balance: { increment: tipAmount } },
	});
	await prismaTx.tip.create({
		data: {
			fromUserId: tipper.id,
			toUserId: recipient.id,
			amount: tipAmount,
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

	// Get permalink to the original message
	let messageLink = "";
	try {
		const permalink = await client.chat.getPermalink({
			channel: channelId,
			message_ts: messageTs,
		});
		messageLink = permalink.permalink || "";
	} catch (err) {
		console.error("[TIP] Failed to get permalink", { err, channelId, messageTs });
	}

	// Calculate recipient's free tips left today
	const recipientTipsGiven = recipient.tipsGivenToday ?? 0;
	const tipsLeft = Math.max(0, dailyTipLimit - recipientTipsGiven);
	let recipientMsg = `🎉 You just received a tip from <@${tipper.slackId}>!`;
	if (messageLink) {
		recipientMsg += `\nSee the message: ${messageLink}`;
	}
	recipientMsg += `\nYou have ${tipsLeft} free tips left to give today.`;
	await sendDM(client, recipient.slackId, recipientMsg);

	// Fetch updated tipper data for accurate counts
	const updatedTipper = await prismaTx.user.findUnique({ where: { id: tipper.id } });
	if (!updatedTipper) return;
	
	// DM the tipper with confirmation and quota/balance info
	const tipperTipsGiven = updatedTipper.tipsGivenToday ?? 0;
	const tipsLeftTipper = Math.max(0, dailyTipLimit - tipperTipsGiven);
	let tipperMsg = `✅ You tipped <@${recipient.slackId}> ${tipAmount.toFixed(2)} USDC!`;
	if (messageLink) {
		tipperMsg += `\nSee the message: ${messageLink}`;
	}

	tipperMsg += `\nNote: <@${recipient.slackId}> does not have a withdrawal address set up yet. Their tip will be credited to their internal balance and sent on-chain when they add an address.`;

	tipperMsg += `\nYou have ${tipsLeftTipper} free tips left today and $${updatedTipper.extraBalance.toFixed(2)} extra balance left.`;
	await sendDM(client, tipper.slackId, tipperMsg);
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

	const settings = await getSettings();
	const tipAmount = new Decimal(settings.tipAmount);
	const dailyTipLimit = Number(settings.dailyFreeTipAmount);

	await prisma.$transaction(async (prismaTx: Prisma.TransactionClient) => {
		if (isSelfTip(tipperSlackId, recipientSlackId)) {
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
			dailyTipLimit,
			tipAmount,
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
			await deductExtraBalance(prismaTx, tipper, tipAmount);
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
				tipAmount,
				dailyTipLimit,
			});
		} else {
			await processInternalTip({
				prismaTx,
				client,
				tipper,
				recipient,
				messageTs,
				channelId,
				tipAmount,
				dailyTipLimit,
			});
		}
	});
});
