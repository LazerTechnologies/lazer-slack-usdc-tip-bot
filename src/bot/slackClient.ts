import { App, LogLevel } from '@slack/bolt';
import dotenv from 'dotenv';
dotenv.config();

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  logLevel: LogLevel.INFO,
  appToken: process.env.SLACK_APP_TOKEN,
  socketMode: true,
});

export default app;
