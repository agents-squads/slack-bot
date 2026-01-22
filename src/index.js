import Bolt from '@slack/bolt';
import { execSync } from 'child_process';
import express from 'express';
import 'dotenv/config';

const { App } = Bolt;

// =============================================================================
// Configuration
// =============================================================================

const REPOS = (process.env.GITHUB_REPOS || '').split(',').filter(Boolean);
const HTTP_PORT = process.env.HTTP_PORT || 3001;
const SCHEDULER_API_URL = process.env.SCHEDULER_API_URL || 'http://localhost:8000';

const APPROVAL_CHANNELS = {
  issue: process.env.SLACK_CHANNEL_ISSUES || 'issue-approvals',
  pr: process.env.SLACK_CHANNEL_PRS || 'pr-approvals',
  content: process.env.SLACK_CHANNEL_CONTENT || 'content-approvals',
  run: process.env.SLACK_CHANNEL_RUNS || 'run-approvals',
  brief: process.env.SLACK_CHANNEL_BRIEFS || 'brief-approvals',
};

// =============================================================================
// Scheduler API Client
// =============================================================================

async function schedulerApi(method, path, body = null) {
  try {
    const options = {
      method,
      headers: { 'Content-Type': 'application/json' },
    };
    if (body) {
      options.body = JSON.stringify(body);
    }
    const response = await fetch(`${SCHEDULER_API_URL}${path}`, options);
    if (!response.ok) {
      const error = await response.text();
      throw new Error(`API error ${response.status}: ${error}`);
    }
    return await response.json();
  } catch (error) {
    console.error(`Scheduler API error (${method} ${path}):`, error.message);
    return null;
  }
}

// =============================================================================
// Slack App (Multi-tenant HTTP mode)
// =============================================================================

// Token cache to avoid repeated API calls
const tokenCache = new Map();
const TOKEN_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

/**
 * Authorize callback for multi-tenant Slack app.
 * Looks up bot tokens from slack_installations table via scheduler API.
 */
async function authorize({ teamId, enterpriseId }) {
  // Check cache first
  const cacheKey = teamId || enterpriseId;
  const cached = tokenCache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < TOKEN_CACHE_TTL) {
    return cached.auth;
  }

  // Query scheduler API for installation tokens
  const installation = await schedulerApi('GET', `/slack/installations/${teamId}/token`);
  if (!installation) {
    // Fallback to env token for backwards compatibility
    if (process.env.SLACK_BOT_TOKEN) {
      console.warn(`No installation for team ${teamId}, using env token fallback`);
      return {
        botToken: process.env.SLACK_BOT_TOKEN,
        botId: process.env.SLACK_BOT_USER_ID,
        botUserId: process.env.SLACK_BOT_USER_ID,
      };
    }
    throw new Error(`No Slack installation found for team ${teamId}`);
  }

  const auth = {
    botToken: installation.bot_token,
    botId: installation.bot_id,
    botUserId: installation.bot_user_id,
  };

  // Cache the result
  tokenCache.set(cacheKey, { auth, timestamp: Date.now() });
  return auth;
}

// Use HTTP mode with authorize callback for multi-tenant
// Falls back to single-tenant Socket Mode if SLACK_APP_TOKEN is set
const isMultiTenant = !process.env.SLACK_APP_TOKEN;

const app = new App(isMultiTenant ? {
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  authorize,
} : {
  token: process.env.SLACK_BOT_TOKEN,
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  socketMode: true,
  appToken: process.env.SLACK_APP_TOKEN,
});

// =============================================================================
// HTTP Server for CLI
// =============================================================================

const httpServer = express();
httpServer.use(express.json());

// =============================================================================
// Helpers
// =============================================================================

function gh(cmd) {
  try {
    return execSync(`gh ${cmd}`, {
      encoding: 'utf-8',
      env: process.env,  // GH_TOKEN already in env
    }).trim();
  } catch (e) {
    console.error('gh error:', e.message);
    return null;
  }
}

function getTypeEmoji(type) {
  const emojis = {
    issue: ':memo:',
    pr: ':git-pull-request:',
    content: ':page_facing_up:',
    run: ':robot_face:',
    brief: ':brain:',
  };
  return emojis[type] || ':grey_question:';
}

function getTypeColor(type) {
  const colors = {
    issue: '#36a64f',
    pr: '#6f42c1',
    content: '#0088cc',
    run: '#ff9500',
    brief: '#e91e63',
  };
  return colors[type] || '#808080';
}

// =============================================================================
// Block Kit Builders
// =============================================================================

function buildApprovalBlocks(approval) {
  const { type, title, description, squad, agent, payload, approval_id, expires_at, priority } = approval;

  const blocks = [];

  // Header
  blocks.push({
    type: 'header',
    text: { type: 'plain_text', text: `${getTypeEmoji(type)} ${title}`, emoji: true }
  });

  // Context
  const contextElements = [
    { type: 'mrkdwn', text: `*Squad:* ${squad}${agent ? ` / ${agent}` : ''}` },
  ];
  if (expires_at) {
    const expireTs = Math.floor(new Date(expires_at).getTime() / 1000);
    contextElements.push({ type: 'mrkdwn', text: `*Expires:* <!date^${expireTs}^{date_short_pretty} at {time}|${expires_at}>` });
  }
  if (priority && priority < 5) {
    contextElements.push({ type: 'mrkdwn', text: ':rotating_light: *High Priority*' });
  }
  blocks.push({ type: 'context', elements: contextElements });

  blocks.push({ type: 'divider' });

  // Type-specific content
  blocks.push(...buildTypeBlocks(type, payload, description));

  blocks.push({ type: 'divider' });

  // Action buttons
  blocks.push(buildActionButtons(type, approval_id));

  return blocks;
}

function buildTypeBlocks(type, payload, description) {
  const blocks = [];

  if (description) {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: description }
    });
  }

  switch (type) {
    case 'issue':
      blocks.push({
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*Repo:* \`${payload.repo || 'unknown'}\`\n*Labels:* ${(payload.labels || []).join(', ') || 'none'}`
        }
      });
      if (payload.body) {
        const preview = payload.body.slice(0, 500);
        blocks.push({
          type: 'section',
          text: { type: 'mrkdwn', text: `\`\`\`${preview}${payload.body.length > 500 ? '...' : ''}\`\`\`` }
        });
      }
      break;

    case 'pr':
      blocks.push({
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*PR:* <${payload.url}|#${payload.number} ${payload.title || ''}>\n*CI:* ${payload.ci_status || 'unknown'}\n*Changes:* ${payload.diff_summary || 'N/A'}`
        }
      });
      break;

    case 'content':
      blocks.push({
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*Platform:* ${payload.platform || 'unknown'}\n*Scheduled:* ${payload.scheduled_time || 'Now'}`
        }
      });
      if (payload.content) {
        const preview = payload.content.slice(0, 800);
        blocks.push({
          type: 'section',
          text: { type: 'mrkdwn', text: `\`\`\`${preview}${payload.content.length > 800 ? '...' : ''}\`\`\`` }
        });
      }
      break;

    case 'run':
      blocks.push({
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*Target:* ${payload.squad || 'unknown'}${payload.agent ? '/' + payload.agent : ''}\n*Trigger:* ${payload.trigger || 'manual'}\n*Est. Cost:* $${payload.estimated_cost?.toFixed(2) || '?'}\n*Est. Duration:* ${payload.estimated_duration_min || '?'} min`
        }
      });
      break;

    case 'brief':
      blocks.push({
        type: 'section',
        text: { type: 'mrkdwn', text: `*Topic:* ${payload.topic || 'Unknown'}` }
      });
      if (payload.summary) {
        blocks.push({
          type: 'section',
          text: { type: 'mrkdwn', text: payload.summary }
        });
      }
      if (payload.recommended_actions?.length) {
        blocks.push({
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `*Recommended Actions:*\n${payload.recommended_actions.map(a => `• ${a}`).join('\n')}`
          }
        });
      }
      break;
  }

  return blocks;
}

function buildActionButtons(type, approvalId) {
  const buttonConfigs = {
    issue: [
      { text: 'Approve', action: 'approve_issue', style: 'primary' },
      { text: 'Reject', action: 'reject_issue', style: 'danger' },
    ],
    pr: [
      { text: 'Merge', action: 'merge_pr', style: 'primary' },
      { text: 'Request Changes', action: 'request_changes_pr' },
    ],
    content: [
      { text: 'Publish', action: 'publish_content', style: 'primary' },
      { text: 'Reject', action: 'reject_content', style: 'danger' },
    ],
    run: [
      { text: 'Execute', action: 'execute_run', style: 'primary' },
      { text: 'Skip', action: 'skip_run', style: 'danger' },
    ],
    brief: [
      { text: 'Act On It', action: 'act_brief', style: 'primary' },
      { text: 'Save', action: 'save_brief' },
      { text: 'Dismiss', action: 'dismiss_brief', style: 'danger' },
    ],
  };

  const buttons = (buttonConfigs[type] || []).map(btn => ({
    type: 'button',
    text: { type: 'plain_text', text: btn.text, emoji: true },
    action_id: btn.action,
    value: approvalId,
    ...(btn.style && { style: btn.style }),
  }));

  return { type: 'actions', elements: buttons };
}

// =============================================================================
// Approval Storage (in-memory cache + Scheduler API)
// =============================================================================

const pendingApprovals = new Map();

async function saveApproval(approval) {
  // Cache locally for quick access
  pendingApprovals.set(approval.approval_id, approval);

  // Persist via scheduler API
  const result = await schedulerApi('POST', '/approvals', {
    approval_id: approval.approval_id,
    type: approval.type,
    squad: approval.squad,
    agent: approval.agent,
    title: approval.title,
    description: approval.description,
    payload: approval.payload,
    slack_channel: approval.slack_channel,
    slack_ts: approval.slack_ts,
    priority: approval.priority || 5,
    expires_at: approval.expires_at,
  });

  return result;
}

async function updateApprovalStatus(approvalId, status, decidedBy, reason = null, outcomeRef = null) {
  // Update local cache
  const approval = pendingApprovals.get(approvalId);
  if (approval) {
    approval.status = status;
    approval.decided_by = decidedBy;
    approval.decided_at = new Date().toISOString();
  }

  // Update via scheduler API
  const action = status === 'approved' ? 'approve' : 'reject';
  const result = await schedulerApi('POST', `/approvals/${approvalId}/decide`, {
    action,
    actor: decidedBy,
    reason,
    outcome_ref: outcomeRef,
  });

  return result;
}

async function getApproval(approvalId) {
  // Check memory first
  if (pendingApprovals.has(approvalId)) {
    return pendingApprovals.get(approvalId);
  }

  // Fetch from scheduler API
  const approval = await schedulerApi('GET', `/approvals/${approvalId}`);

  if (approval) {
    // Parse payload if it's a string
    if (typeof approval.payload === 'string') {
      approval.payload = JSON.parse(approval.payload);
    }
    // Cache for future use
    pendingApprovals.set(approvalId, approval);
    return approval;
  }

  return null;
}

// =============================================================================
// Message Updates
// =============================================================================

async function updateApprovalMessage(approval, message, success) {
  const statusEmoji = success ? ':white_check_mark:' : ':x:';
  const statusText = success ? 'Approved' : 'Rejected';

  try {
    await app.client.chat.update({
      channel: approval.slack_channel,
      ts: approval.slack_ts,
      blocks: [
        {
          type: 'header',
          text: { type: 'plain_text', text: `${statusEmoji} ${statusText}: ${approval.title}`, emoji: true }
        },
        {
          type: 'context',
          elements: [
            { type: 'mrkdwn', text: message },
          ]
        },
      ],
      text: message,
    });
  } catch (error) {
    console.error('Failed to update message:', error.message);
  }
}

// =============================================================================
// HTTP API Endpoints
// =============================================================================

httpServer.post('/api/approval/send', async (req, res) => {
  try {
    const approval = req.body;

    // Find channel
    const channelName = APPROVAL_CHANNELS[approval.type] || 'general';
    const channelList = await app.client.conversations.list({
      types: 'public_channel,private_channel',
      limit: 200,
    });
    const channelObj = channelList.channels?.find(c => c.name === channelName.replace('#', ''));

    if (!channelObj) {
      throw new Error(`Channel #${channelName} not found. Create it first.`);
    }

    // Post message
    const result = await app.client.chat.postMessage({
      channel: channelObj.id,
      blocks: buildApprovalBlocks(approval),
      text: `Approval needed: ${approval.title}`,
    });

    // Store
    approval.slack_channel = channelObj.id;
    approval.slack_ts = result.ts;
    approval.status = 'pending';
    await saveApproval(approval);

    console.log(`Approval ${approval.approval_id} sent to #${channelName}`);

    res.json({
      success: true,
      approval_id: approval.approval_id,
      channel: channelName,
      slack_ts: result.ts,
    });
  } catch (error) {
    console.error('Failed to send approval:', error);
    res.status(500).json({ error: error.message });
  }
});

httpServer.get('/api/approval/:id', async (req, res) => {
  const approval = await getApproval(req.params.id);
  if (!approval) {
    res.status(404).json({ error: 'Approval not found' });
    return;
  }
  res.json(approval);
});

httpServer.get('/api/approvals', async (req, res) => {
  const status = req.query.status || 'pending';
  const approvals = await schedulerApi('GET', `/approvals?status=${status}`);
  res.json(approvals || []);
});

httpServer.get('/health', async (req, res) => {
  // Check scheduler API health
  const schedulerHealth = await schedulerApi('GET', '/health');
  res.json({
    status: 'ok',
    pending: pendingApprovals.size,
    scheduler: schedulerHealth ? 'connected' : 'disconnected',
  });
});

httpServer.get('/api/approvals/stats', async (req, res) => {
  const stats = await schedulerApi('GET', '/approvals/stats');
  res.json(stats || {});
});

// =============================================================================
// Slack Message Response (for Claude Code session)
// =============================================================================

httpServer.post('/api/slack/respond', async (req, res) => {
  try {
    const { channel_id, thread_ts, text, message_id } = req.body;

    if (!channel_id || !text) {
      res.status(400).json({ error: 'channel_id and text are required' });
      return;
    }

    // Post the response to Slack
    const result = await app.client.chat.postMessage({
      channel: channel_id,
      text: text,
      thread_ts: thread_ts || undefined,
    });

    console.log(`Response sent to ${channel_id}${thread_ts ? ' (thread)' : ''}`);

    // Update message status in scheduler API if message_id provided
    if (message_id) {
      await schedulerApi('POST', `/slack/messages/${message_id}/responded`, {
        response_ts: result.ts,
      });
    }

    res.json({
      success: true,
      ts: result.ts,
      channel: channel_id,
    });
  } catch (error) {
    console.error('Failed to respond to Slack:', error);
    res.status(500).json({ error: error.message });
  }
});

// =============================================================================
// Post Messages (no approval needed - just share info)
// =============================================================================

httpServer.post('/api/post', async (req, res) => {
  try {
    const { channel, squad, agent, title, body, emoji, color } = req.body;

    // Find channel
    const channelName = channel || APPROVAL_CHANNELS.brief || 'social';
    const channelList = await app.client.conversations.list({
      types: 'public_channel,private_channel',
      limit: 200,
    });
    const channelObj = channelList.channels?.find(c => c.name === channelName.replace('#', ''));

    if (!channelObj) {
      throw new Error(`Channel #${channelName} not found`);
    }

    // Build message blocks
    const blocks = [
      {
        type: 'header',
        text: { type: 'plain_text', text: `${emoji || ':robot_face:'} ${title}`, emoji: true }
      },
      {
        type: 'context',
        elements: [
          { type: 'mrkdwn', text: `*Squad:* ${squad}${agent ? ` / ${agent}` : ''} • ${new Date().toLocaleString()}` }
        ]
      },
      { type: 'divider' },
      {
        type: 'section',
        text: { type: 'mrkdwn', text: body }
      }
    ];

    // Post message
    const result = await app.client.chat.postMessage({
      channel: channelObj.id,
      blocks,
      text: title,
    });

    console.log(`Posted to #${channelName}: ${title}`);

    res.json({
      success: true,
      channel: channelName,
      ts: result.ts,
    });
  } catch (error) {
    console.error('Failed to post message:', error);
    res.status(500).json({ error: error.message });
  }
});

// =============================================================================
// Action Handlers
// =============================================================================

async function handleAction(body, ack, action, actionType) {
  await ack();

  const approvalId = action.value;
  const approval = await getApproval(approvalId);
  const user = body.user.username;

  if (!approval) {
    await app.client.chat.postEphemeral({
      channel: body.channel.id,
      user: body.user.id,
      text: ':warning: Approval not found or already processed',
    });
    return;
  }

  if (approval.status !== 'pending') {
    await app.client.chat.postEphemeral({
      channel: body.channel.id,
      user: body.user.id,
      text: `:warning: Already ${approval.status} by ${approval.decided_by}`,
    });
    return;
  }

  let outcome = null;
  let success = false;
  let message = '';

  try {
    switch (actionType) {
      // Issue actions
      case 'approve_issue': {
        const { repo, title: issueTitle, body: issueBody, labels } = approval.payload;
        const labelFlags = (labels || []).map(l => `-l "${l}"`).join(' ');
        outcome = gh(`issue create -R ${repo} --title "${issueTitle}" --body "${issueBody}" ${labelFlags}`);
        success = outcome !== null;
        message = success ? `Issue created by @${user}` : 'Failed to create issue';
        break;
      }

      case 'reject_issue':
        success = true;
        message = `Issue rejected by @${user}`;
        break;

      // PR actions
      case 'merge_pr': {
        const { repo, number } = approval.payload;
        gh(`pr review ${number} -R ${repo} --approve -b "Approved via Slack by @${user}"`);
        outcome = gh(`pr merge ${number} -R ${repo} --squash --delete-branch`);
        success = outcome !== null;
        message = success ? `PR #${number} merged by @${user}` : 'Failed to merge PR';
        break;
      }

      case 'request_changes_pr': {
        const { repo, number } = approval.payload;
        gh(`pr review ${number} -R ${repo} --request-changes -b "Changes requested via Slack by @${user}"`);
        success = true;
        message = `Changes requested on PR #${number} by @${user}`;
        break;
      }

      // Content actions
      case 'publish_content':
        // TODO: Trigger content-publisher agent
        success = true;
        message = `Content approved for publishing by @${user}`;
        outcome = 'queued';
        break;

      case 'reject_content':
        success = true;
        message = `Content rejected by @${user}`;
        break;

      // Run actions
      case 'execute_run': {
        const { squad, agent } = approval.payload;
        const cmd = agent
          ? `squads run ${squad} -a ${agent} --execute`
          : `squads run ${squad} --execute`;
        try {
          execSync(cmd, { cwd: process.env.HQ_PATH || process.cwd() });
          success = true;
          message = `Run initiated by @${user}`;
        } catch (e) {
          success = false;
          message = `Run failed: ${e.message}`;
        }
        break;
      }

      case 'skip_run':
        success = true;
        message = `Run skipped by @${user}`;
        break;

      // Brief actions
      case 'act_brief': {
        const { recommended_actions, topic } = approval.payload;
        for (const action of (recommended_actions || []).slice(0, 5)) {
          gh(`issue create -R agents-squads/hq --title "Brief: ${action.slice(0, 50)}" --body "From brief: ${topic}\n\n${action}" -l from-brief`);
        }
        success = true;
        message = `Brief actions created by @${user}`;
        break;
      }

      case 'save_brief':
        success = true;
        message = `Brief saved by @${user}`;
        break;

      case 'dismiss_brief':
        success = true;
        message = `Brief dismissed by @${user}`;
        break;

      default:
        message = `Unknown action: ${actionType}`;
    }

    // Update status
    const status = success ? 'approved' : 'rejected';
    await updateApprovalStatus(approvalId, status, user, null, outcome);

    // Update Slack message
    await updateApprovalMessage(approval, message, success);

  } catch (error) {
    console.error(`Action ${actionType} failed:`, error);
    await app.client.chat.postEphemeral({
      channel: body.channel.id,
      user: body.user.id,
      text: `:x: Action failed: ${error.message}`,
    });
  }
}

// Register all action handlers
const allActions = [
  'approve_issue', 'reject_issue',
  'merge_pr', 'request_changes_pr',
  'publish_content', 'reject_content',
  'execute_run', 'skip_run',
  'act_brief', 'save_brief', 'dismiss_brief',
];

allActions.forEach(actionId => {
  app.action(actionId, async (args) => {
    await handleAction(args.body, args.ack, args.action, actionId);
  });
});

// =============================================================================
// Existing PR Commands (for backwards compatibility)
// =============================================================================

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
      // Generate approval ID for this PR
      const approvalId = `pr_${Date.now().toString(36)}_${pr.number}`;

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
          action_id: 'legacy_merge_pr',
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

// Legacy merge handler (for /prs command)
app.action('legacy_merge_pr', async ({ body, ack, respond }) => {
  await ack();

  const { repo, number, title } = JSON.parse(body.actions[0].value);
  const user = body.user.username;

  gh(`pr review ${number} -R ${repo} --approve -b "Approved via Slack by @${user}"`);
  const result = gh(`pr merge ${number} -R ${repo} --squash --delete-branch`);

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

app.command('/review', async ({ command, ack, respond }) => {
  await ack();

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

// =============================================================================
// Conversational Interface - Talk to the Coordinator
// =============================================================================

// Handle @Squads mentions in channels
app.event('app_mention', async ({ event, say, context }) => {
  const text = event.text.replace(/<@[A-Z0-9]+>/g, '').trim();
  const user = event.user;
  const threadTs = event.thread_ts || event.ts;
  const teamId = context?.teamId || event.team;

  console.log(`@mention from ${user} (team: ${teamId}): ${text}`);

  try {
    // Queue the request for Claude Code session
    const response = await handleCoordinatorRequest(text, user, event.channel, threadTs, teamId);

    if (response) {
      // Immediate response (error case)
      await say({
        text: response,
        thread_ts: threadTs,
      });
    }
    // If null, message is queued - response will come via /api/slack/respond
  } catch (error) {
    console.error('Coordinator error:', error);
    await say({
      text: `:warning: Error: ${error.message}`,
      thread_ts: threadTs,
    });
  }
});

// Handle DMs to the bot
app.event('message', async ({ event, say, context }) => {
  // Only handle DMs (im) and ignore bot messages
  if (event.channel_type !== 'im' || event.bot_id) return;

  const text = event.text;
  const user = event.user;
  const threadTs = event.thread_ts || event.ts;
  const teamId = context?.teamId || event.team;

  console.log(`DM from ${user} (team: ${teamId}): ${text}`);

  try {
    // Queue the request for Claude Code session
    const response = await handleCoordinatorRequest(text, user, event.channel, threadTs, teamId);

    if (response) {
      // Immediate response (error case)
      await say({
        text: response,
        thread_ts: threadTs,
      });
    }
    // If null, message is queued - response will come via /api/slack/respond
  } catch (error) {
    console.error('Coordinator error:', error);
    await say({
      text: `:warning: Error: ${error.message}`,
      thread_ts: threadTs,
    });
  }
});

// Queue message for Claude Code session to handle
async function handleCoordinatorRequest(text, userId, channel, threadTs = null, teamId = null) {
  // Generate unique message ID
  const messageId = `msg_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

  // Get team_id from parameter or fall back to env
  const resolvedTeamId = teamId || process.env.SLACK_TEAM_ID || 'unknown';

  try {
    // Queue message via scheduler API
    const result = await schedulerApi('POST', '/slack/messages', {
      message_id: messageId,
      team_id: resolvedTeamId,
      channel_id: channel,
      user_id: userId,
      thread_ts: threadTs,
      text: text,
      context: {
        source: 'slack',
        timestamp: new Date().toISOString(),
      },
    });

    if (!result) {
      return ':warning: Could not queue message. Scheduler API not available.';
    }

    // Message queued - Claude Code session will pick it up
    return null; // Return null to indicate async handling (no immediate response)
  } catch (error) {
    console.error('Queue message error:', error);
    return `:warning: Error: ${error.message}`;
  }
}

async function getSquadsStatus() {
  try {
    const result = execSync('squads status 2>/dev/null || echo "Status unavailable"', {
      encoding: 'utf-8',
      cwd: process.env.HQ_PATH || '/hq',
      timeout: 30000,
    }).trim();

    // Strip ANSI codes for Slack
    const clean = result.replace(/\x1B\[[0-9;]*[mGKH]/g, '');
    return `\`\`\`\n${clean}\n\`\`\``;
  } catch (e) {
    return ':warning: Could not get status. Is the squads CLI available?';
  }
}

async function listSquads() {
  try {
    const result = execSync('squads list 2>/dev/null || echo "List unavailable"', {
      encoding: 'utf-8',
      cwd: process.env.HQ_PATH || '/hq',
      timeout: 30000,
    }).trim();

    const clean = result.replace(/\x1B\[[0-9;]*[mGKH]/g, '');
    return `\`\`\`\n${clean}\n\`\`\``;
  } catch (e) {
    return ':warning: Could not list squads.';
  }
}

async function runSquad(target) {
  // Safety: only allow specific squads to be run
  const allowed = ['intelligence', 'research', 'website', 'cli'];
  const squad = target.split('/')[0].toLowerCase();

  if (!allowed.includes(squad)) {
    return `:no_entry: Squad "${squad}" not allowed via Slack. Allowed: ${allowed.join(', ')}`;
  }

  return `:rocket: To run *${target}*, use:\n\`\`\`squads run ${target}\`\`\`\n_Direct execution from Slack coming soon._`;
}

async function queryIntelligence(question) {
  // For now, return a placeholder. Later this will call Claude or an intelligence agent.
  return `:brain: *Intelligence Query*\n\nYou asked: "${question}"\n\n_Intelligence agent integration coming soon. For now, use \`squads run intelligence\` to get briefings._`;
}

function getHelpMessage() {
  return `:wave: *I'm the Squads Coordinator*

Here's what I can do:

• \`status\` - Get squad status
• \`list\` - List all squads and agents
• \`run <squad>\` - Run a squad (coming soon)
• Ask me questions about your business

*Examples:*
• "What's the status?"
• "List all squads"
• "Run intelligence"
• "What did the research squad find?"`;
}

// =============================================================================
// Expiration Checker
// =============================================================================

async function checkExpiredApprovals() {
  // Call scheduler API to expire approvals
  const result = await schedulerApi('POST', '/approvals/expire');

  if (result?.expired?.length) {
    for (const approval of result.expired) {
      console.log(`Approval ${approval.approval_id} expired`);

      // Update Slack message
      try {
        await app.client.chat.update({
          channel: approval.slack_channel,
          ts: approval.slack_ts,
          blocks: [
            {
              type: 'header',
              text: { type: 'plain_text', text: `:hourglass: Expired: ${approval.title}`, emoji: true }
            },
            {
              type: 'context',
              elements: [
                { type: 'mrkdwn', text: 'This approval request has expired without a decision.' },
              ]
            },
          ],
          text: 'Approval expired',
        });
      } catch (e) {
        console.error('Failed to update expired message:', e.message);
      }

      // Remove from memory
      pendingApprovals.delete(approval.approval_id);
    }
  }
}

// Run expiration check every minute
setInterval(checkExpiredApprovals, 60000);

// =============================================================================
// Start
// =============================================================================

(async () => {
  // Start Slack bot
  await app.start();
  console.log(`Slack bot running (${isMultiTenant ? 'HTTP multi-tenant' : 'Socket Mode single-tenant'})`);
  console.log(`Monitoring repos: ${REPOS.join(', ') || 'none configured'}`);
  console.log(`Approval channels: ${Object.values(APPROVAL_CHANNELS).join(', ')}`);
  console.log(`Scheduler API: ${SCHEDULER_API_URL}`);

  // Check scheduler connectivity
  const health = await schedulerApi('GET', '/health');
  if (health) {
    console.log('Scheduler API: connected');
  } else {
    console.warn('Warning: Scheduler API not reachable at', SCHEDULER_API_URL);
  }

  // Start HTTP server
  httpServer.listen(HTTP_PORT, () => {
    console.log(`HTTP API running on port ${HTTP_PORT}`);
  });

  // Initial expiration check
  await checkExpiredApprovals();
})();
