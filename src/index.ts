import app from './bot/slackClient.ts';
import './bot/tipping';
import './bot/homeTab';
import './db/setupAdmins';

const port = process.env.PORT || 3000;

(async () => {
  await app.start(port);
  console.log(`⚡️ Slack Tip Bot is running on port ${port}`);
})();
