import app from "./slackClient.ts";
import prisma from "../db/prismaClient.ts";
import { getUserDepositAccount, sweep } from "../blockchain/wallet.ts";
import { isAddress } from "viem";
import type { User as UserType, Tip } from "../generated/index.ts";
import {
	getUSDCBalance,
	adminAccount,
	publicClient,
	USDCContract,
} from "../blockchain/wallet.ts";
import { maxInt256, formatUnits } from "viem";
import { blockchainQueue } from "../blockchain/tx-queue.ts";
import type { KnownBlock } from "@slack/web-api";
import type { ActionsBlockElement } from '@slack/types';

// Helper to build Home Tab blocks dynamically
async function getHomeTabBlocks(user: UserType | null) {
	// --- Global Stats ---
	// Total amount of tips ever given
	const totalTipsAgg = await prisma.tip.aggregate({ _sum: { amount: true } });
	const totalTipsEver = totalTipsAgg._sum.amount?.toString() || "0";

	// Tips sent today
	const today = new Date();
	today.setHours(0, 0, 0, 0);
	const tipsSentToday = await prisma.tip.count({
		where: { createdAt: { gte: today } },
	});

	// Biggest tipper (most sent)
	const biggestTipperAgg = await prisma.tip.groupBy({
		by: ["fromUserId"],
		_sum: { amount: true },
		orderBy: { _sum: { amount: "desc" } },
		take: 1,
	});
	let biggestTipper = "-";
	let biggestTipperAmount = "0";
	if (biggestTipperAgg.length > 0) {
		const tipperUser = await prisma.user.findUnique({ where: { id: biggestTipperAgg[0].fromUserId } });
		if (tipperUser) {
			biggestTipper = `<@${tipperUser.slackId}>`;
			biggestTipperAmount = biggestTipperAgg[0]._sum.amount?.toString() || "0";
		}
	}

	// Biggest receiver (most received)
	const biggestReceiverAgg = await prisma.tip.groupBy({
		by: ["toUserId"],
		_sum: { amount: true },
		orderBy: { _sum: { amount: "desc" } },
		take: 1,
	});
	let biggestReceiver = "-";
	let biggestReceiverAmount = "0";
	if (biggestReceiverAgg.length > 0) {
		const receiverUser = await prisma.user.findUnique({ where: { id: biggestReceiverAgg[0].toUserId } });
		if (receiverUser) {
			biggestReceiver = `<@${receiverUser.slackId}>`;
			biggestReceiverAmount = biggestReceiverAgg[0]._sum.amount?.toString() || "0";
		}
	}

	const balance = user ? user.balance.toString() : "0";
	const extraBalance = user ? user.extraBalance.toString() : "0";
	const depositAddress = user?.depositAddress || "Not set";
	const withdrawalAddress = user?.ethAddress || "Not set";
	const DAILY_TIP_LIMIT = 10;
	const tipsGivenToday = user?.tipsGivenToday ?? 0;
	const tipsLeft = Math.max(0, DAILY_TIP_LIMIT - tipsGivenToday);
	const actions: ActionsBlockElement[] = [];
	if (!user?.depositAddress) {
		actions.push({
			type: "button",
			text: { type: "plain_text", text: "➕ Generate Deposit Address" },
			action_id: "generate_deposit_address",
			style: "primary",
		});
	}
	actions.push(
		{
			type: "button",
			text: { type: "plain_text", text: "🏦 Set Withdrawal Address" },
			action_id: "set_withdrawal_address",
			style: "primary",
		},
		{
			type: "button",
			text: { type: "plain_text", text: "💸 Sweep Deposit Balance" },
			action_id: "sweep_deposit_balance",
			style: "danger",
		},
	);
	if (user?.ethAddress && user.extraBalance && Number(user.extraBalance) > 0) {
		actions.push({
			type: "button",
			text: { type: "plain_text", text: "⬇️ Withdraw Extra Balance" },
			action_id: "withdraw_extra_balance",
			style: "primary",
		});
	}

	// --- Fetch stats ---
	type TipSent = Tip & { toUser: { slackId: string } };
	type TipReceived = Tip & { fromUser: { slackId: string } };
	let tipsSent: TipSent[] = [];
	let tipsReceived: TipReceived[] = [];
	let totalTipped = "0";
	let totalReceived = "0";
	if (user) {
		const [sent, received, sentAgg, receivedAgg] = await Promise.all([
			prisma.tip.findMany({
				where: { fromUserId: user.id },
				orderBy: { createdAt: "desc" },
				take: 10,
				include: { toUser: true },
			}) as Promise<TipSent[]>,
			prisma.tip.findMany({
				where: { toUserId: user.id },
				orderBy: { createdAt: "desc" },
				take: 10,
				include: { fromUser: true },
			}) as Promise<TipReceived[]>,
			prisma.tip.aggregate({
				where: { fromUserId: user.id },
				_sum: { amount: true },
			}),
			prisma.tip.aggregate({
				where: { toUserId: user.id },
				_sum: { amount: true },
			}),
		]);
		tipsSent = sent;
		tipsReceived = received;
		totalTipped = sentAgg._sum.amount?.toString() || "0";
		totalReceived = receivedAgg._sum.amount?.toString() || "0";
	}

	const tipsSentSection =
		tipsSent.length > 0
			? tipsSent
					.map(
						(tip) =>
							`• <@${tip.toUser.slackId}> — ${tip.amount.toString()} USDC  ${tip.hash ? `<https://basescan.org/tx/${tip.hash}|🔗>` : ""}`,
					)
					.join("\n")
			: "No tips sent yet.";

	const tipsReceivedSection =
		tipsReceived.length > 0
			? tipsReceived
					.map(
						(tip) =>
							`• <@${tip.fromUser.slackId}> — ${tip.amount.toString()} USDC  ${tip.hash ? `<https://basescan.org/tx/${tip.hash}|🔗>` : ""}`,
					)
					.join("\n")
			: "No tips received yet.";

	// --- Admin wallet info ---
	const adminEthAddress = adminAccount.address;
	let adminEthBalance = "...";
	let adminUsdcBalance = "...";
	try {
		// ETH balance: get from publicClient.getBalance
		const eth = await publicClient.getBalance({ address: adminEthAddress as `0x${string}` });
		adminEthBalance = (Number(eth) / 1e18).toFixed(10);
		const usdcBal = await getUSDCBalance(adminEthAddress as `0x${string}`);
		adminUsdcBalance = (Number(usdcBal) / 1e6).toFixed(2);
	} catch (e) {
		adminEthBalance = "error";
		adminUsdcBalance = "error";
	}

	// Calculate local midnight for the user (server time, but formatted as local)
	const resetDate = new Date();
	resetDate.setHours(0, 0, 0, 0);
	const resetTimeLocal = resetDate.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

	// --- Admin Settings ---
	const settings = await prisma.settings.findUnique({ where: { id: 1 } });
	const isAdmin = user && settings && settings.adminSlackIds.includes(user.slackId);

	const blocks: KnownBlock[] = [
		{
			type: "section",
			text: { type: "mrkdwn", text: "*🌎 Global Tip Stats*" },
		},
		{
			type: "section",
			fields: [
				{ type: "mrkdwn", text: `*Total Tips Ever:*
${totalTipsEver} USDC` },
				{ type: "mrkdwn", text: `*Tips Sent Today:*
${tipsSentToday}` },
				{ type: "mrkdwn", text: `*Biggest Tipper 👑:*
${biggestTipper} (${biggestTipperAmount} USDC)` },
				{ type: "mrkdwn", text: `*Biggest Receiver 💰:*
${biggestReceiver} (${biggestReceiverAmount} USDC)` },
			],
		},
		{ type: "divider" },
		{
			type: "section",
			text: {
				type: "mrkdwn",
				text: "*👑 Admin Wallet Info*\nYou can send USDC or ETH to the admin address below to add extra tips to the pool and power transactions."
			},
		},
		{
			type: "section",
			fields: [
				{ type: "mrkdwn", text: `*Address:*\n<https://basescan.org/address/${adminEthAddress}|\`${adminEthAddress}\`>` },
				{ type: "mrkdwn", text: `*ETH Balance:*\n${adminEthBalance} ETH _(for gas/transaction fees)_` },
				{ type: "mrkdwn", text: `*USDC Balance:*\n${adminUsdcBalance} USDC _(tip pool: where tips are sent from)_` },
			],
		},
		{ type: "divider" },
		{
			type: "section",
			text: { type: "mrkdwn", text: "*💰 Your USDC Tip Bot Account*" },
		},
		{
			type: "section",
			fields: [
				// Only show balance if (no deposit address) OR (balance > 0)
				...((depositAddress === "Not set" || balance !== "0")
					? [{ type: "mrkdwn" as const, text: `*Balance:*\n*${balance}* USDC _(free tips)_` }]
					: []),
				{ type: "mrkdwn" as const, text: `*Extra Balance:*\n*${extraBalance}* USDC _(deposited for extra tips)_` },
				{ type: "mrkdwn" as const, text: `*Tips Left Today:*\n*${tipsLeft}* / ${DAILY_TIP_LIMIT} 🎁  _(resets daily at midnight server time)_` },
				{ type: "mrkdwn" as const, text: `*Deposit Address:*\n${depositAddress !== "Not set" ? `<https://basescan.org/address/${depositAddress}|\`${depositAddress}\`>` : "Not set"} ${(depositAddress !== "Not set") ? "_(click sweep below to update after sent)_" : ""}` },
				{ type: "mrkdwn" as const, text: `*Withdrawal Address:*\n${withdrawalAddress !== "Not set" ? `<https://basescan.org/address/${withdrawalAddress}|\`${withdrawalAddress}\`>` : "Not set"}` },
			],
		},
		{
			type: "section",
			fields: [
				{ type: "mrkdwn" as const, text: `*Total Tipped:*\n${totalTipped} USDC` },
				{ type: "mrkdwn" as const, text: `*Total Received:*\n${totalReceived} USDC` },
			],
		},
		{ type: "divider" },
		{
			type: "section",
			text: { type: "mrkdwn", text: `*🕒 Last 10 Tips Sent:*
${tipsSentSection}` },
		},
		{
			type: "section",
			text: { type: "mrkdwn", text: `*🕒 Last 10 Tips Received:*
${tipsReceivedSection}` },
		},
		{
			type: "actions",
			elements: actions,
		},
	];

	if (isAdmin && settings) {
		blocks.push(
			{ type: "divider" },
			{
				type: "section",
				text: { type: "mrkdwn", text: "*⚙️ Admin Settings*" },
			},
			{
				type: "section",
				fields: [
					{ type: "mrkdwn", text: `*Admins:*
${settings.adminSlackIds.map(id => `<@${id}>`).join(", ")}` },
					{ type: "mrkdwn", text: `*Daily Free Tip Amount:*
${settings.dailyFreeTipAmount}` },
					{ type: "mrkdwn", text: `*Tip Amount:*
${settings.tipAmount}` },
				],
			},
			{
				type: "actions",
				elements: [
					{
						type: "button",
						text: { type: "plain_text", text: "➕ Add Admin" },
						action_id: "add_admin_modal",
						style: "primary"
					},
					{
						type: "button",
						text: { type: "plain_text", text: "➖ Remove Admin" },
						action_id: "remove_admin_modal",
						style: "danger"
					},
					{
						type: "button",
						text: { type: "plain_text", text: "✏️ Edit Daily Free Tip" },
						action_id: "edit_daily_tip_modal"
					},
					{
						type: "button",
						text: { type: "plain_text", text: "✏️ Edit Tip Amount" },
						action_id: "edit_tip_amount_modal"
					}
				]
			}
		);
	}

	return blocks;
}

// Home Tab handler
app.event("app_home_opened", async ({ event, client }) => {
	const slackId = event.user;
	// Fetch user info from DB
	const user = await prisma.user.findUnique({ where: { slackId } });

	const blocks = await getHomeTabBlocks(user);

	await client.views.publish({
		user_id: slackId,
		view: {
			type: "home",
			callback_id: "home_view",
			blocks,
		},
	});
});

// Handle Generate Deposit Address button
app.action("generate_deposit_address", async ({ ack, body, client }) => {
	await ack();
	const slackId = body.user.id;
	// Find or create user
	const user = await prisma.user.upsert({
		where: { slackId },
		create: { slackId },
		update: {},
	});
	// Generate deposit address (using user.id as index)
	const depositAccount = getUserDepositAccount(user.id);
	if (user.depositAddress !== depositAccount.address) {
		await prisma.user.update({
			where: { id: user.id },
			data: { depositAddress: depositAccount.address },
		});
	}
	// Refresh Home Tab
	const updatedUser = await prisma.user.findUnique({ where: { slackId } });
	const blocks = await getHomeTabBlocks(updatedUser);
	await client.views.publish({
		user_id: slackId,
		view: {
			type: "home",
			callback_id: "home_view",
			blocks,
		},
	});
});

// Handle Set Withdrawal Address button (open modal)
app.action("set_withdrawal_address", async ({ ack, body, client }) => {
	await ack();
	// Slack Bolt types don't always include trigger_id, but it's present at runtime
	// @ts-expect-error: trigger_id is present on body
	const trigger_id = body.trigger_id;
	if (!trigger_id) return;
	await client.views.open({
		trigger_id,
		view: {
			type: "modal",
			callback_id: "withdrawal_address_modal",
			title: { type: "plain_text", text: "Set Withdrawal Address" },
			submit: { type: "plain_text", text: "Save" },
			close: { type: "plain_text", text: "Cancel" },
			blocks: [
				{
					type: "section",
					text: {
						type: "mrkdwn",
						text: "*This is the address where your tips will be sent directly when you receive them. It should be a wallet you control on the Base blockchain, or a USDC deposit address for Base on Coinbase or another centralized exchange.*"
					}
				},
				{
					type: "input",
					block_id: "eth_address_block",
					label: { type: "plain_text", text: "Ethereum Address" },
					element: {
						type: "plain_text_input",
						action_id: "eth_address_input",
						placeholder: { type: "plain_text", text: "0x..." },
					},
				},
			],
		},
	});
});

// Handle modal submission
app.view("withdrawal_address_modal", async ({ ack, body, view, client }) => {
	await ack();
	const slackId = body.user.id;
	const ethAddress =
		view.state.values.eth_address_block.eth_address_input.value || "";
	if (!ethAddress || !isAddress(ethAddress)) {
		// Optionally, you can send an ephemeral message or error
		return;
	}
	await prisma.user.update({ where: { slackId }, data: { ethAddress } });
	// Refresh Home Tab
	const user = await prisma.user.findUnique({ where: { slackId } });
	const blocks = await getHomeTabBlocks(user);
	await client.views.publish({
		user_id: slackId,
		view: {
			type: "home",
			callback_id: "home_view",
			blocks,
		},
	});
});

// Handle Sweep Deposit Balance button
app.action("sweep_deposit_balance", async ({ ack, body, client }) => {
	await ack();
	const slackId = body.user.id;
	const user = await prisma.user.upsert({
		where: { slackId },
		create: { slackId },
		update: {},
	});
	// Check for deposit address
	let depositAddress = user.depositAddress;
	if (!depositAddress) {
		const depositAccount = getUserDepositAccount(user.id);
		await prisma.user.update({
			where: { id: user.id },
			data: { depositAddress: depositAccount.address },
		});
		depositAddress = depositAccount.address;
	}
	// Check for USDC balance
	const depositAddressTyped = depositAddress as `0x${string}`;
	const balance = await getUSDCBalance(depositAddressTyped);
	if (balance > 0n) {
		blockchainQueue.add(async () => {
			const hash = await sweep({
				fromIndex: user.id,
				to: adminAccount.address,
				amount: balance,
				validAfter: 0n,
				validBefore: maxInt256,
			});
			await publicClient.waitForTransactionReceipt({ hash });
			await prisma.user.update({
				where: { id: user.id },
				data: { extraBalance: { increment: formatUnits(balance, 6) } },
			});
			await client.chat.postMessage({
				channel: slackId,
				text: `Your deposit of ${formatUnits(balance, 6)} USDC has been processed! https://basescan.org/tx/${hash}`,
			});
		});
		await client.chat.postMessage({
			channel: slackId,
			text: `Checking for deposits for <@${slackId}>...`,
		});
	} else {
		await client.chat.postMessage({
			channel: slackId,
			text: `No new USDC deposits found for <@${slackId}>.`,
		});
	}
});

// Handle Withdraw Extra Balance button
app.action("withdraw_extra_balance", async ({ ack, body, client }) => {
	await ack();
	const slackId = body.user.id;
	const user = await prisma.user.findUnique({ where: { slackId } });
	if (!user || !user.ethAddress || !user.extraBalance || Number(user.extraBalance) <= 0) {
		await client.chat.postMessage({
			channel: slackId,
			text: "You must have a withdrawal address set and a positive extra balance to withdraw.",
		});
		return;
	}
	// Convert extraBalance (stored as normal USDC, e.g. 1.96) to smallest unit for transfer
	const amount = BigInt(Math.round(Number(user.extraBalance) * 1_000_000)); // USDC has 6 decimals
	const to = user.ethAddress as `0x${string}`;
	try {
		blockchainQueue.add(async () => {
			// Standard USDC transfer from admin wallet to user withdrawal address
			const txHash = await USDCContract.write.transfer([to, amount]);
			await publicClient.waitForTransactionReceipt({ hash: txHash });
			await prisma.user.update({
				where: { id: user.id },
				data: { extraBalance: 0 },
			});
			await client.chat.postMessage({
				channel: slackId,
				text: `Withdrew ${user.extraBalance} USDC to your withdrawal address! https://basescan.org/tx/${txHash}`,
			});
		});
		await client.chat.postMessage({
			channel: slackId,
			text: `Processing withdrawal of ${user.extraBalance} USDC to <${user.ethAddress}>...`,
		});
	} catch (e) {
		await client.chat.postMessage({
			channel: slackId,
			text: `Error processing withdrawal: ${e}`,
		});
	}
});

// Add Admin Modal
app.action("add_admin_modal", async ({ ack, body, client }) => {
	await ack();
	// @ts-expect-error: trigger_id is present on body
	const trigger_id = body.trigger_id;
	await client.views.open({
		trigger_id,
		view: {
			type: "modal",
			title: { type: "plain_text", text: "Add Admin" },
			submit: { type: "plain_text", text: "Add" },
			close: { type: "plain_text", text: "Cancel" },
			callback_id: "add_admin_submit",
			blocks: [
				{
					type: "input",
					block_id: "admin_id_block",
					label: { type: "plain_text", text: "Slack User ID" },
					element: {
						type: "plain_text_input",
						action_id: "admin_id_input",
						placeholder: { type: "plain_text", text: "U12345678" }
					}
				}
			]
		}
	});
});

app.view("add_admin_submit", async ({ ack, body, view, client }) => {
	await ack();
	const slackId = body.user.id;
	const newAdminId = view.state.values.admin_id_block.admin_id_input.value;
	const settings = await prisma.settings.findUnique({ where: { id: 1 } });
	if (settings && newAdminId && !settings.adminSlackIds.includes(newAdminId)) {
		await prisma.settings.update({
			where: { id: 1 },
			data: { adminSlackIds: { set: [...settings.adminSlackIds, newAdminId] } }
		});
	}
	const user = await prisma.user.findUnique({ where: { slackId } });
	const blocks = await getHomeTabBlocks(user);
	await client.views.publish({
		user_id: slackId,
		view: { type: "home", callback_id: "home_view", blocks }
	});
});

// Remove Admin Modal
app.action("remove_admin_modal", async ({ ack, body, client }) => {
	await ack();
	// @ts-expect-error: trigger_id is present on body
	const trigger_id = body.trigger_id;
	const settings = await prisma.settings.findUnique({ where: { id: 1 } });
	await client.views.open({
		trigger_id,
		view: {
			type: "modal",
			title: { type: "plain_text", text: "Remove Admin" },
			submit: { type: "plain_text", text: "Remove" },
			close: { type: "plain_text", text: "Cancel" },
			callback_id: "remove_admin_submit",
			blocks: [
				{
					type: "input",
					block_id: "admin_id_block",
					label: { type: "plain_text", text: "Slack User ID to Remove" },
					element: {
						type: "static_select",
						action_id: "admin_id_select",
						options: settings?.adminSlackIds.map(id => ({
							text: { type: "plain_text", text: id },
							value: id
						})) || []
					}
				}
			]
		}
	});
});

app.view("remove_admin_submit", async ({ ack, body, view, client }) => {
	await ack();
	const slackId = body.user.id;
	const selected = view.state.values.admin_id_block.admin_id_select.selected_option;
	const removeId = selected ? selected.value : undefined;
	const settings = await prisma.settings.findUnique({ where: { id: 1 } });
	if (settings && removeId && settings.adminSlackIds.includes(removeId)) {
		await prisma.settings.update({
			where: { id: 1 },
			data: { adminSlackIds: { set: settings.adminSlackIds.filter(id => id !== removeId) } }
		});
	}
	const user = await prisma.user.findUnique({ where: { slackId } });
	const blocks = await getHomeTabBlocks(user);
	await client.views.publish({
		user_id: slackId,
		view: { type: "home", callback_id: "home_view", blocks }
	});
});

// Edit Daily Free Tip Modal
app.action("edit_daily_tip_modal", async ({ ack, body, client }) => {
	await ack();
	// @ts-expect-error: trigger_id is present on body
	const trigger_id = body.trigger_id;
	const settings = await prisma.settings.findUnique({ where: { id: 1 } });
	await client.views.open({
		trigger_id,
		view: {
			type: "modal",
			title: { type: "plain_text", text: "Edit Daily Tip" }, // shortened to <25 chars
			submit: { type: "plain_text", text: "Save" },
			close: { type: "plain_text", text: "Cancel" },
			callback_id: "edit_daily_tip_submit",
			blocks: [
				{
					type: "input",
					block_id: "daily_tip_block",
					label: { type: "plain_text", text: "Daily Free Tip Amount" },
					element: {
						type: "plain_text_input",
						action_id: "daily_tip_input",
						initial_value: settings?.dailyFreeTipAmount.toString() || "10"
					}
				}
			]
		}
	});
});

app.view("edit_daily_tip_submit", async ({ ack, body, view, client }) => {
	await ack();
	const slackId = body.user.id;
	const dailyTipValue = view.state.values.daily_tip_block.daily_tip_input.value;
	const amount = Number.parseFloat(dailyTipValue ?? "");
	if (!Number.isNaN(amount) && amount > 0) {
		await prisma.settings.update({ where: { id: 1 }, data: { dailyFreeTipAmount: amount } });
	}
	const user = await prisma.user.findUnique({ where: { slackId } });
	const blocks = await getHomeTabBlocks(user);
	await client.views.publish({
		user_id: slackId,
		view: { type: "home", callback_id: "home_view", blocks }
	});
});

// Edit Tip Amount Modal
app.action("edit_tip_amount_modal", async ({ ack, body, client }) => {
	await ack();
	// @ts-expect-error: trigger_id is present on body
	const trigger_id = body.trigger_id;
	const settings = await prisma.settings.findUnique({ where: { id: 1 } });
	await client.views.open({
		trigger_id,
		view: {
			type: "modal",
			title: { type: "plain_text", text: "Edit Tip Amount" },
			submit: { type: "plain_text", text: "Save" },
			close: { type: "plain_text", text: "Cancel" },
			callback_id: "edit_tip_amount_submit",
			blocks: [
				{
					type: "input",
					block_id: "tip_amount_block",
					label: { type: "plain_text", text: "Tip Amount" },
					element: {
						type: "plain_text_input",
						action_id: "tip_amount_input",
						initial_value: settings?.tipAmount.toString() || "0.01"
					}
				}
			]
		}
	});
});

app.view("edit_tip_amount_submit", async ({ ack, body, view, client }) => {
	await ack();
	const slackId = body.user.id;
	const tipAmountValue = view.state.values.tip_amount_block.tip_amount_input.value;
	const amount = Number.parseFloat(tipAmountValue ?? "");
	if (!Number.isNaN(amount) && amount > 0) {
		await prisma.settings.update({ where: { id: 1 }, data: { tipAmount: amount } });
	}
	const user = await prisma.user.findUnique({ where: { slackId } });
	const blocks = await getHomeTabBlocks(user);
	await client.views.publish({
		user_id: slackId,
		view: { type: "home", callback_id: "home_view", blocks }
	});
});
