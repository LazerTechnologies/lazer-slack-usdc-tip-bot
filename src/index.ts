import app from './bot/slackClient';
import './bot/tipping';
import './bot/withdrawal';
import './bot/deposit';
import './bot/update';

const port = process.env.PORT || 3000;

(async () => {
  await app.start(port);
  console.log(`⚡️ Slack Tip Bot is running on port ${port}`);
})();
