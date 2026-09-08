# SolvaX MD

Telegram-controlled WhatsApp bot built with Baileys.

## Setup
1. Node.js 20+
2. `npm install`
3. Set `BOT_TOKEN` (recommended) or put the token in `config.json` as `telegramToken`.
4. `npm start`

For Railway, attach a persistent volume and set `WA_SESSION_DIR` to its mount path so WhatsApp authentication survives restarts.

## Telegram
`/start` `/help` `/pair` `/cancel` `/status` `/stop`

## WhatsApp
Commands use `.`. The linked WhatsApp account is the only account allowed to issue bot commands. Group moderation commands still verify group permissions.

Implemented: menu, ping, group info, tagall, tagadmin, add/kick/promote/demote, mute, anti-link/mention/view-once/bot configuration, image sticker conversion, YouTube search, lyrics/video search.

`.vv` deliberately does not bypass WhatsApp view-once privacy. YouTube commands return search results rather than downloading media.

## Security
Never commit Telegram tokens or WhatsApp session files. Keep `sessions/` persistent but private.
