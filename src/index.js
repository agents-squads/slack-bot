import Bolt from '@slack/bolt';
import { execSync } from 'child_process';
import 'dotenv/config';

const { App } = Bolt;

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  socketMode: true,
  appToken: process.env.SLACK_APP_TOKEN,
});

const REPOS = (process.env.GITHUB_REPOS || '').split(',').filter(Boolean);

// Helper to run gh CLI
function gh(cmd) {
  try {
    return execSync(`gh ${cmd}`, {
      encoding: 'utf-8',
      env: { ...process.env, GH_TOKEN: process.env.GITHUB_TOKEN }
    }).trim();
  } catch (e) {
    return null;
  }
}

// /prs - List open PRs with merge buttons
app.command('/prs', async ({ command, ack, respond }) => {
  await ack();

  const blocks = [
    {
      type: 'header',
      text: { type: 'plain_text', text: 'Open Pull Requests', emoji: true }
    }
  ];

  let totalPRs = 0;

  for (const repo of REPOS) {
    const output = gh(`pr list -R ${repo} --json number,title,author,url --limit 10`);
    if (!output) continue;

    const prs = JSON.parse(output);
    if (prs.length === 0) continue;

    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: `*${repo}*` }
    });

    for (const pr of prs) {
      totalPRs++;
      blocks.push({
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `<${pr.url}|#${pr.number}> ${pr.title}\n_by ${pr.author.login}_`
        },
        accessory: {
          type: 'button',
          text: { type: 'plain_text', text: 'Merge', emoji: true },
          style: 'primary',
          action_id: `merge_pr`,
          value: JSON.stringify({ repo, number: pr.number, title: pr.title })
        }
      });
    }

    blocks.push({ type: 'divider' });
  }

  if (totalPRs === 0) {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: '_No open PRs across any repos_' }
    });
  }

  await respond({ blocks });
});

// Handle merge button click
app.action('merge_pr', async ({ body, ack, respond, client }) => {
  await ack();

  const { repo, number, title } = JSON.parse(body.actions[0].value);
  const user = body.user.username;

  // First, approve the PR (adds to review count)
  gh(`pr review ${number} -R ${repo} --approve -b "Approved via Slack by @${user}"`);

  // Then merge
  const result = gh(`pr merge ${number} -R ${repo} --merge --delete-branch`);

  if (result !== null) {
    await respond({
      replace_original: false,
      text: `Merged *#${number}* in \`${repo}\` - ${title}`
    });
  } else {
    await respond({
      replace_original: false,
      text: `Failed to merge #${number} in ${repo}. Check if there are conflicts or required checks.`
    });
  }
});

// /review - Quick approve a PR
app.command('/review', async ({ command, ack, respond }) => {
  await ack();

  // Expected format: /review repo#number or /review repo number
  const text = command.text.trim();
  const match = text.match(/^([\w-]+\/[\w-]+)[#\s]+(\d+)$/);

  if (!match) {
    await respond('Usage: `/review owner/repo #123` or `/review owner/repo 123`');
    return;
  }

  const [, repo, number] = match;
  const result = gh(`pr review ${number} -R ${repo} --approve -b "Approved via Slack"`);

  if (result !== null) {
    await respond(`Approved PR #${number} in \`${repo}\``);
  } else {
    await respond(`Failed to approve PR #${number} in ${repo}`);
  }
});

// Start
(async () => {
  await app.start();
  console.log('Slack bot is running!');
  console.log(`Monitoring repos: ${REPOS.join(', ')}`);
})();
