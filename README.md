# Agents Squads Slack Bot

Slack bot for PR management - list, review, and merge PRs with one click.

## Commands

| Command | Description |
|---------|-------------|
| `/prs` | List all open PRs with merge buttons |
| `/review repo#123` | Approve a specific PR |

## Setup

### 1. Create Slack App

1. Go to [api.slack.com/apps](https://api.slack.com/apps)
2. **Create New App** → **From scratch**
3. Name: `Squads Bot`, Workspace: yours

### 2. Configure App

**OAuth & Permissions** → Bot Token Scopes:
- `commands`
- `chat:write`

**Slash Commands** → Create:
- `/prs` - List open pull requests
- `/review` - Approve a pull request

**Socket Mode** → Enable (creates App Token)

### 3. Install & Get Tokens

1. **Install to Workspace**
2. Copy **Bot User OAuth Token** (`xoxb-...`)
3. Copy **Signing Secret** (Basic Information)
4. Copy **App Token** (`xapp-...`) from Socket Mode

### 4. Run

```bash
cp .env.example .env
# Fill in tokens

npm install
npm start
```

## How It Works

```
You: /prs
Bot: 📋 Open PRs:
     #23 - Add templates [Merge]
     #5 - Fix memory     [Merge]

You: *clicks Merge*
Bot: ✅ Merged #23 in squads-cli
```

The merge button:
1. Approves the PR (counts as a review!)
2. Merges with `--merge` strategy
3. Deletes the branch

## Deploy

For always-on, deploy to:
- **Railway** - `railway up`
- **Render** - Connect repo
- **Fly.io** - `fly launch`

Or run locally with `npm start`.
