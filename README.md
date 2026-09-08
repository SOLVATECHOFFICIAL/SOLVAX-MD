# SolvaX MD

A Telegram-controlled WhatsApp bot using Baileys.

## Setup

1. Install Node.js 20+.
2. Put the Telegram bot token in the environment as `BOT_TOKEN`, or use `telegramToken` in `config.json`.
3. Run:

```bash
npm install
npm start
```

On Railway, add `BOT_TOKEN` under Variables. The project contains `railway.json` and a `Procfile`.

## Telegram

- `/start`
- `/help`
- `/pair`
- `/cancel`
- `/status`
- `/stop`

For `/pair`, enter a WhatsApp number with country code, for example `2349012345678`. Nigerian local numbers such as `08012345678` are also accepted.

## WhatsApp

The command prefix is `.`.

`.menu`, `.ping`, `.sticker`, `.play`, `.video`, `.lyrics`, `.groupinfo`, `.tagall`, `.tagadmin`, `.add`, `.kick`, `.promote`, `.demote`, `.mute`, `.anti`, `.vv`.

`.play` and `.video` perform YouTube searches; they do not download copyrighted media. `.lyrics` performs a lyrics/video search without reproducing copyrighted lyrics. `.vv` intentionally does not bypass view-once privacy controls.

### Group controls

- `.add`, `.kick`, `.promote`, `.demote`, `.mute`, `.anti`, and `.tagall` require group-admin permission.
- The bot must be a group admin for moderation commands.
- `.anti` removes links sent by non-admin members.
- `.mute` prevents non-admin members from invoking bot commands while enabled.

Private WhatsApp commands are restricted to the linked account. Group commands can be used by members, with admin-only commands protected by group permissions.

## Session storage

By default, Baileys authentication is stored in `sessions/`. For a persistent deployment, set `WA_SESSION_DIR` to a durable mounted directory/volume. A process restart should not intentionally delete authentication; `/stop`, `/cancel`, logout, and bad-session cleanup can remove authentication when appropriate.

Never commit the `sessions/` directory, Telegram token, or WhatsApp credentials.
