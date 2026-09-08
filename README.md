# SolvaX MD

A Telegram-controlled WhatsApp bot using Baileys.

## Setup

1. Install Node.js 20+.
2. Put your Telegram bot token in the environment as `BOT_TOKEN`.
3. Run:

```bash
npm install
npm start
```

On Railway, add `BOT_TOKEN` under Variables. The project already contains `railway.json` and a `Procfile`.

## Telegram

- `/start`
- `/help`
- `/pair`
- `/status`
- `/stop`

For `/pair`, enter the WhatsApp number with country code and digits only, for example `2349012345678`.

## WhatsApp

The command prefix is `.`.

`.menu`, `.ping`, `.sticker`, `.play`, `.video`, `.lyrics`, `.groupinfo`, `.tagall`, `.tagadmin`, `.add`, `.kick`, `.promote`, `.demote`, `.mute`, `.anti`, `.vv`.

`.vv` intentionally does not bypass view-once privacy controls.

## Important deployment note

The default auth store is file-based. Railway's filesystem should not be treated as permanent storage for production sessions. If a deployment is recreated, the WhatsApp session files may disappear and require pairing again. For a serious multi-user deployment, move the auth state to durable database/object storage.

Never commit the `sessions/` directory, Telegram token, or WhatsApp credentials.
