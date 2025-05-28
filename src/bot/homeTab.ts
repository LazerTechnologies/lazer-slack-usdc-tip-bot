import app from "./slackClient";
import prisma from "../db/prismaClient";
import { getUserDepositAccount } from "../blockchain/wallet";
import { isAddress } from "viem";
import type { User as UserType, Tip } from "../generated";

// Helper to build Home Tab blocks dynamically
async function getHomeTabBlocks(user: UserType | null) {
  const balance = user ? user.balance.toString() : "0";
  const depositAddress = user?.depositAddress || "Not set";
  const withdrawalAddress = user?.ethAddress || "Not set";
  const DAILY_TIP_LIMIT = 10;
  const tipsGivenToday = user?.tipsGivenToday ?? 0;
  const tipsLeft = DAILY_TIP_LIMIT - tipsGivenToday;
  const actions: Record<string, unknown>[] = [];
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
    }
  );

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
              `• <@${tip.toUser.slackId}> — ${tip.amount.toString()} USDC  ${tip.hash ? `<https://basescan.org/tx/${tip.hash}|🔗>` : ""}`
          )
          .join("\n")
      : "No tips sent yet.";

  const tipsReceivedSection =
    tipsReceived.length > 0
      ? tipsReceived
          .map(
            (tip) =>
              `• <@${tip.fromUser.slackId}> — ${tip.amount.toString()} USDC  ${tip.hash ? `<https://basescan.org/tx/${tip.hash}|🔗>` : ""}`
          )
          .join("\n")
      : "No tips received yet.";

  return [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text:
          `*💰 Your USDC Tip Bot Account*
*Balance:* *${balance}* USDC
*Deposit Address:* \
\`${depositAddress}\`
*Withdrawal Address:* \
\`${withdrawalAddress}\`
*Tips Left Today:* *${tipsLeft}* / ${DAILY_TIP_LIMIT} 🎁\n\n` +
          `*📊 Lifetime Stats:*
• *Total Tipped:* ${totalTipped} USDC
• *Total Received:* ${totalReceived} USDC\n\n` +
          `*🕒 Last 10 Tips Sent:*
${tipsSentSection}\n\n` +
          `*🕒 Last 10 Tips Received:*
${tipsReceivedSection}`,
      },
    },
    {
      type: "actions",
      elements: actions,
    },
  ];
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
  const user = await prisma.user.upsert({ where: { slackId }, create: { slackId }, update: {} });
  // Generate deposit address (using user.id as index)
  const depositAccount = getUserDepositAccount(user.id);
  if (user.depositAddress !== depositAccount.address) {
    await prisma.user.update({ where: { id: user.id }, data: { depositAddress: depositAccount.address } });
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
  const ethAddress = view.state.values.eth_address_block.eth_address_input.value || "";
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
  const user = await prisma.user.upsert({ where: { slackId }, create: { slackId }, update: {} });
  // Check for deposit address
  let depositAddress = user.depositAddress;
  if (!depositAddress) {
    const { getUserDepositAccount } = await import("../blockchain/wallet");
    const depositAccount = getUserDepositAccount(user.id);
    await prisma.user.update({ where: { id: user.id }, data: { depositAddress: depositAccount.address } });
    depositAddress = depositAccount.address;
  }
  // Check for USDC balance
  const { getUSDCBalance, adminAccount, sweep } = await import("../blockchain/wallet");
  const { maxInt256 } = await import("viem");
  // Ensure depositAddress is a valid Address type
  const depositAddressTyped = depositAddress as `0x${string}`;
  const balance = await getUSDCBalance(depositAddressTyped);
  if (balance > 0n) {
    const { blockchainQueue } = await import("../blockchain/tx-queue");
    const { formatUnits } = await import("viem");
    blockchainQueue.add(async () => {
      const hash = await sweep({
        fromIndex: user.id,
        to: adminAccount.address,
        amount: balance,
        validAfter: 0n,
        validBefore: maxInt256,
      });
      const { publicClient } = await import("../blockchain/wallet");
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
