import app from './slackClient';
import prisma from '../db/prismaClient';
import { adminAccount, getUSDCBalance, USDCContract, publicClient } from '../blockchain/wallet';
import { Decimal } from '@prisma/client/runtime/library';
import { blockchainQueue } from '../blockchain/tx-queue';

const TIP_AMOUNT = new Decimal(0.01);
const DAILY_TIP_LIMIT = 10;

// Helper to send a DM to a user
async function sendDM(client: any, userId: string, text: string) {
  const dm = await client.conversations.open({ users: userId });
  const dmChannel = dm.channel.id ? dm.channel.id : null;
  if (dmChannel) {
    await client.chat.postMessage({ channel: dmChannel, text });
    console.log('[TIP] Sent DM', { userId, dmChannel });
  } else {
    console.error('[TIP] Failed to open DM channel', { userId, dm });
  }
}

app.event('reaction_added', async ({ event, client, context, say }) => {
  if (!event.reaction || (event.reaction !== 'dollar' && event.reaction !== '$')) return;
  console.log("[TIP] Reaction added event received");
  const tipperSlackId = event.user;
  const messageTs = event.item.ts;
  const channelId = event.item.channel;
  const recipientSlackId = event.item_user;
  if (!recipientSlackId) return;

  // Run the main logic in a Prisma transaction for concurrency safety and speed
  await prisma.$transaction(async (prismaTx) => {
    // Prevent self-tipping
    if (tipperSlackId === recipientSlackId) {
      console.log('[TIP] Self-tipping detected, aborting', { tipperSlackId, recipientSlackId });
      await sendDM(client, tipperSlackId, "You can't tip yourself!");
      return;
    }

    // Prevent duplicate tips on same message
    console.log('[TIP] Checking for duplicate tip', { tipperSlackId, recipientSlackId, messageTs });
    const existingTip = await prismaTx.tip.findFirst({
      where: {
        fromUser: { slackId: tipperSlackId },
        toUser: { slackId: recipientSlackId },
        messageTs,
      },
    });
    if (existingTip) {
      console.log('[TIP] Duplicate tip detected, aborting', { tipperSlackId, recipientSlackId, messageTs });
      await sendDM(client, tipperSlackId, `You already tipped <@${recipientSlackId}> for this post.`);
      return;
    }

    // Check tipper's daily quota
    console.log('[TIP] Checking daily quota', { tipperSlackId });
    const tipper = await prismaTx.user.upsert({
      where: { slackId: tipperSlackId },
      update: {},
      create: { slackId: tipperSlackId },
    });
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    let tipsGivenToday = tipper.tipsGivenToday;
    if (!tipper.lastTipDate || tipper.lastTipDate < today) {
      // Reset tipsGivenToday if it's a new day
      tipsGivenToday = 0;
      await prismaTx.user.update({
        where: { id: tipper.id },
        data: { tipsGivenToday: 0, lastTipDate: new Date() },
      });
    }

    const hasFreeTips = tipsGivenToday < DAILY_TIP_LIMIT;
    const hasExtraBalance = tipper.extraBalance?.gte(TIP_AMOUNT);

    if (!hasFreeTips && !hasExtraBalance) {
      console.log('[TIP] Daily limit and extra balance exhausted', { tipperSlackId, tipsGivenToday });
      await sendDM(client, tipperSlackId, "You've reached your daily free tip limit and have no extra balance left!");
      return;
    }

    // Deduct from free tips or extraBalance as appropriate
    let useExtraBalance = false;
    if (!hasFreeTips && hasExtraBalance) {
      // Deduct from extraBalance
      await prismaTx.user.update({
        where: { id: tipper.id },
        data: { extraBalance: { decrement: TIP_AMOUNT } },
      });
      useExtraBalance = true;
    }

    // Upsert recipient
    console.log('[TIP] Upserting recipient', { recipientSlackId });
    const recipient = await prismaTx.user.upsert({
      where: { slackId: recipientSlackId },
      update: {},
      create: { slackId: recipientSlackId },
    });

    console.log('Recipient details', recipient)

    // If recipient has no withdrawal address, notify them (only once per day)
    if (!recipient.ethAddress) {
      console.log('[TIP] Recipient has no withdrawal address, notifying', { recipientSlackId });
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const recipientTipsLeft = DAILY_TIP_LIMIT - (recipient.tipsGivenToday + 1);
      if (!recipient.lastTipDate || recipient.lastTipDate < today) {
        await sendDM(client, recipientSlackId, `You received a tip!\nYou have ${recipientTipsLeft} free tips left to give today.\nTo withdraw your USDC, DM me your Ethereum address`);
        await prismaTx.user.update({
          where: { slackId: recipientSlackId },
          data: { lastTipDate: new Date() },
        });
      }
    }

    // If recipient has a withdrawal address, queue blockchain transfer (do not block transaction)
    if (recipient.ethAddress) {
      // Save the tip as 'pending' in the DB
      const tip = await prismaTx.tip.create({
        data: {
          fromUserId: tipper.id,
          toUserId: recipient.id,
          amount: TIP_AMOUNT,
          messageTs,
          channelId,
          hash: null, // will be updated after blockchain tx
        },
      });
      // Mark tipper's tip count
      await prismaTx.user.update({
        where: { id: tipper.id },
        data: {
          tipsGivenToday: { increment: 1 },
          lastTipDate: new Date(),
        },
      });
      // Queue blockchain transfer (async, outside transaction)
      blockchainQueue.add(async () => {
        try {
          const amount = BigInt(TIP_AMOUNT.mul(1e6).toFixed(0));
          const to = recipient.ethAddress as `0x${string}`;
          const adminBalance = await getUSDCBalance(adminAccount.address);
          if (adminBalance < amount) {
            await sendDM(client, tipperSlackId, `You tipped <@${recipientSlackId}> 0.01 USDC! (Insufficient on-chain balance, credited to internal balance)`);
            await prisma.user.update({
              where: { id: recipient.id },
              data: { balance: { increment: TIP_AMOUNT } },
            })
            return;
          }
          console.log('[TIP] Sending on-chain transfer', { to, amount: amount.toString() });
          const hash = await USDCContract.write.transfer([to, amount]);
          console.log('[TIP] Transfer sent', { hash });
          await publicClient.waitForTransactionReceipt({ hash, confirmations: 1 });
          console.log('[TIP] Transfer confirmed', { hash });

          await prisma.tip.update({
            where: { id: tip.id },
            data: { hash },
          });
          const basecanUrl = `https://basescan.org/tx/${hash}`;
          await sendDM(client, recipientSlackId, `You just received a tip from <@${tipperSlackId}> to ${recipient.ethAddress}\nView transaction: ${basecanUrl}`);
        } catch (err) {
          await sendDM(client, tipperSlackId, `Tip failed to send on-chain: ${err}`);
        }
      });
      // Notify tipper immediately
      const tipsLeft = DAILY_TIP_LIMIT - (tipper.tipsGivenToday + 1);
      await sendDM(client, tipperSlackId, `You tipped <@${recipientSlackId}> 0.01 USDC! You have ${tipsLeft} tips left today.\nMessage "deposit" to and I will generate a USDC deposit address to give you extra balance for tipping.`);
    } else {
      // Credit tip in internal balance
      console.log('[TIP] Crediting internal balance', { recipientSlackId });
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
      await sendDM(client, tipperSlackId, `You tipped <@${recipientSlackId}> 0.01 USDC! You have ${DAILY_TIP_LIMIT - (tipper.tipsGivenToday + 1)} tips left today.\nMessage "deposit" to and I will generate a USDC deposit address to give you extra balance for tipping.`);
      await sendDM(client, recipientSlackId, `You just received a tip from <@${tipperSlackId}>!\nYou have ${recipient.balance} USDC accrued.\nTo withdraw your USDC, DM me your wallet address`);
    }
  });
});
