import { getUserDepositAccount } from '../blockchain/wallet';
import db from '../db/prismaClient';
import type { SayArguments } from '@slack/bolt';
import app from './slackClient';


  app.message(/^deposit$/i, async ({ message, say }) => {
    if (!('user' in message)) return; 
    const slackId = message.user as string;
    // Find or create user in DB
    const user = await db.user.upsert({ where: { slackId }, create: { slackId }, update: {} });

    // Use user.id as the index for deposit account
    const depositAccount = getUserDepositAccount(user.id);
    // Save deposit address to DB if not already set
    if (user.depositAddress !== depositAccount.address) {
      await db.user.update({
        where: { id: user.id },
        data: { depositAddress: depositAccount.address },
      });
    }
    // Respond to user with their deposit address
    const response: SayArguments = {
      text: `Your USDC deposit address is: \`${depositAccount.address}\`\nSend USDC (Base chain) to this address and then send "update" to me and I will update your extra tipping balance :).`,
    };
    await say(response);
  });

