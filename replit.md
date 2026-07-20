# Telegram MEGA Bot

A Telegram bot that downloads files from MEGA cloud storage and uploads them directly to Telegram chats.

## Stack
- **Runtime**: Node.js 20
- **Key libraries**: Telegraf (bot framework), telegram (MTProto client), megajs (MEGA API)

## How to run
The `Start bot` workflow runs `node bot.js` automatically. Start or restart it from the Workflows panel.

## Required secrets
All set via Replit Secrets:
| Secret | Description |
|--------|-------------|
| `BOT_TOKEN` | Telegram bot token (from @BotFather) |
| `API_ID` | Telegram API ID (from my.telegram.org) |
| `API_HASH` | Telegram API hash (from my.telegram.org) |
| `MEGA_EMAIL` | MEGA account email |
| `MEGA_PASSWORD` | MEGA account password |

## Entry point
- `bot.js` — main bot logic (commands, file handling, MTProto upload)
- `mega-api.js` — MEGA download helpers
- `megaManager.js` — MEGA session/folder management
- `queue.js` — upload queue

## User preferences
<!-- Add any preferences here -->
