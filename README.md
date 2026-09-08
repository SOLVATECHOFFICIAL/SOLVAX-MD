# ⚔️ SOLVAX MD v11

**Complete WhatsApp Bot** with 19 commands, anti-system, and Telegram pairing.

> **⚠️ SECURITY NOTICE:** This README contains NO secrets. Your Telegram Bot Token must be set as an environment variable (`BOT_TOKEN`) in your deployment platform (Railway/Render). NEVER commit it to GitHub.

---

## 👑 Owner Info

| Item | Value |
| :--- | :--- |
| **Bot Name** | SOLVAX MD |
| **Owner** | Solomon |
| **Version** | v11.0.0 |
| **Country** | Nigeria (234) |

---

## 📋 Features

### 🔹 19 WhatsApp Commands

| Category | Count | Commands |
| :--- | :--- | :--- |
| **Everyone** | 8 | `.menu` `.ping` `.vv` `.play` `.video` `.sticker` `.lyrics` `.groupinfo` |
| **Admin Force** | 7 | `.tagall` `.tagadmin` `.add` `.kick` `.promote` `.demote` `.mute` (`.lock`/`.unlock`) |
| **Anti-System** | 4 | `.antilink` `.antimention` `.antiviewonce` `.antibot` |

### 🔹 5 Telegram Commands

| Command | What it does |
| :--- | :--- |
| `/start` | Welcome message |
| `/help` | Full command list |
| `/pair 234xxx` | Generate WhatsApp pairing code |
| `/status` | Check WhatsApp connection |
| `/stop` | Disconnect WhatsApp |

### 🔹 Core Systems

| System | Description |
| :--- | :--- |
| **Database** | JSON file – warnings survive restarts |
| **Queue** | First-come-first-serve processing |
| **View-Once** | 5 decryption methods for `.vv` |
| **Media** | 3 sources for `.play` and `.video` |
| **Auto-Delete** | Loading messages disappear automatically |
| **Private/Public** | Smart reply routing |

---

## 📂 Project Structure

```

solvax-md/
│
├── index.js          # Main bot code (19 commands)
├── package.json      # Dependencies
├── config.json       # Your settings (owner, bot name, etc.)
├── README.md         # This file
├── Procfile          # Render deployment
├── railway.json      # Railway deployment
├── .gitignore        # Ignored files
│
├── auth_info/        # Auto-created (WhatsApp sessions)
└── database.json     # Auto-created (anti-system warnings)

```

---

## 🚀 Deployment Guide

### Option 1: Deploy to Railway (Recommended)

**Step 1:** Fork this repo to your GitHub account.

**Step 2:** Go to [railway.app](https://railway.app) and sign in with GitHub.

**Step 3:** Click **"New Project"** → **"Deploy from GitHub repo"** → Select your repo.

**Step 4:** Go to **Variables** tab and add:

| Key | Value |
| :--- | :--- |
| `BOT_TOKEN` | `YOUR_TELEGRAM_BOT_TOKEN` (from @BotFather) |

**Step 5:** Railway auto-deploys. Done! 🎉

---

### Option 2: Deploy to Render (Free)

**Step 1:** Fork this repo to your GitHub account.

**Step 2:** Go to [render.com](https://render.com) and sign in with GitHub.

**Step 3:** Click **"New +"** → **"Web Service"** → Connect your repo.

**Step 4:** Set:

| Setting | Value |
| :--- | :--- |
| Build Command | `npm install` |
| Start Command | `node index.js` |

**Step 5:** Add environment variable:

| Key | Value |
| :--- | :--- |
| `BOT_TOKEN` | `YOUR_TELEGRAM_BOT_TOKEN` (from @BotFather) |

**Step 6:** Click **"Deploy"**.

**Step 7:** Keep Render awake (free):
- Sign up at [cron-job.org](https://cron-job.org)
- Create a cron job that pings your Render URL every 5 minutes

---

### Option 3: Deploy to VPS (DigitalOcean, AWS, etc.)

**Step 1:** Install Node.js and npm on your VPS.

**Step 2:** Clone the repo:
```bash
git clone https://github.com/YOUR_USERNAME/solvax-md
cd solvax-md
```

Step 3: Install dependencies:

```bash
npm install
```

Step 4: Create .env file:

```bash
echo "BOT_TOKEN=YOUR_TELEGRAM_BOT_TOKEN" > .env
```

Step 5: Start with PM2 (keeps running 24/7):

```bash
npm install -g pm2
pm2 start index.js --name solvax-md
pm2 save
pm2 startup
```

---

📱 How To Pair Your WhatsApp

Step 1: Open Telegram and find your bot (the username you gave @BotFather).

Step 2: Send:

```
/pair 23409063285877
```

(Replace with your own number – country code, no +)

Step 3: Bot replies with an 8-digit pairing code.

Step 4: Open WhatsApp → Linked Devices → Link with phone number.

Step 5: Type the 8-digit code.

Step 6: ✅ Connected! You can now use commands in WhatsApp.

---

📱 WhatsApp Commands Guide

📜 Everyone Commands (8)

Command What it does Reply
.menu Shows full command list Private
.ping Checks if bot is alive Private
.vv Views view-once media Private
.play song Downloads MP3 from YouTube Public
.video song Downloads MP4 from YouTube Public
.sticker Converts image/video to sticker Private
.lyrics song Fetches song lyrics Public
.groupinfo Shows group stats Private

👑 Admin Commands (7)

Command What it does Reply
.tagall Mention everyone Public
.tagadmin Mention all admins Public
.add 234xxx Add number to group Public
.kick @tag Remove tagged person Public
.promote @tag Make admin (any admin can use) Public
.demote @tag Remove admin (any admin can use) Public
.mute on/off Close/open chat Public
.lock/.unlock Same as mute on/off Public

🛡️ Anti-System Commands (4)

Command Protects against Reply
.antilink Links in group Private
.antimention @all spam Private
.antiviewonce View-once messages Private
.antibot Other bots using commands Private

Anti-System Options (all 4 commands):

Option What it does
on / off Enable or disable
kick / delete / warn Choose action
admin on / admin off Apply to admins or not
warns <n> Set max warnings
resetwarns Reset all warnings
clearwarns @tag Clear specific user's warnings

Example Usage:

```
.antilink on
.antilink kick
.antilink admin on
.antilink warns 3
.antilink resetwarns
.antilink clearwarns @tag
```

Typing just .antilink shows the current settings panel.

---

🔧 Configuration

Edit config.json to customize:

```json
{
  "ownerNumber": "23409063285877",
  "botName": "SOLVAX MD",
  "ownerName": "Solomon",
  "coOwners": [],
  "autoDeleteLoading": true,
  "vvMethods": 5,
  "playSources": 3,
  "groupInfoShowMembers": false
}
```

Field What it does
ownerNumber Your WhatsApp number (with country code)
botName The name shown in the menu
ownerName Your name shown in the menu
coOwners Additional numbers allowed to promote/demote
autoDeleteLoading Auto-delete loading messages (true/false)
vvMethods Number of decryption methods to try (1-5)
playSources Number of sources to try (1-3)
groupInfoShowMembers Show member list in groupinfo

---

💡 Private vs Public Replies

Type Commands Where reply goes
Private .menu .ping .vv .sticker .groupinfo + all anti-commands Only the user sees it
Public .play .video .lyrics + all admin commands Whole group sees it

Why this matters:

· Private commands don't spam the group
· Public commands let everyone enjoy music, videos, and lyrics together

---

⚠️ Important Notes

Note Details
WhatsApp Group Creator Cannot be kicked or demoted (WhatsApp rule)
Bot Uses Your Number If YOU are admin, the bot has admin powers
Anti-System Warnings Saved in database.json – survive restarts
Pairing Code Expires in 5 minutes – send /pair again
Multiple Users Each user gets their own WhatsApp session

---

🛠️ Built With

Library Purpose
@whiskeysockets/baileys WhatsApp connection
telegraf Telegram bot
ytdl-core YouTube audio/video
node-fetch API requests
sharp Image processing (stickers)
fluent-ffmpeg Video processing

---

❓ Troubleshooting

Q: Bot says "Cannot kick Owner"
A: WhatsApp protects group creators. The creator cannot be kicked by anyone.

Q: .play says "All music sources busy"
A: YouTube rate-limits requests. Try again in 5 minutes.

Q: .vv fails to decrypt
A: WhatsApp updates often break view-once decryption. Try asking the sender to send normally.

Q: Render keeps sleeping
A: Set up cron-job.org to ping your Render URL every 5 minutes.

Q: Bot says "Make me an admin first"
A: The bot uses your number. You need to be an admin in that group for admin commands to work.

Q: Multiple users can't pair
A: Each user gets their own session. They each need to send /pair with their own number.

---

🔒 Security Best Practices

Practice Why
Never commit BOT_TOKEN to GitHub Anyone can steal your bot
Use environment variables Keep secrets safe on Railway/Render
Add .env to .gitignore Prevents accidental exposure
Limit who can see your repo Make it private if you have sensitive data

---

📞 Support

· Telegram Bot: @solvax_mdbot
· Owner: Solomon
· Purpose: Teaching Web Development

---

📜 License

This bot is for educational purposes. Free to use, modify, and teach.

---

🎯 Version History

Version Date Changes
v11.0.0 2026 Full release – 19 commands, anti-system, queue, 5 VV methods, 3 play sources
v10.0.0 2026 Beta – 12 commands, basic anti-system
v9.0.0 2025 Alpha – Core commands only

---

📊 Statistics

Category Count
WhatsApp Commands 19
Telegram Commands 5
Total Commands 24
Anti-System Protections 4
View-Once Methods 5
Music Sources 3
Files 7

---

🙏 Acknowledgments

· Baileys Library – WhatsApp connection
· Telegraf – Telegram framework
· ytdl-core – YouTube downloads
· Solomon (Owner) – Vision and teaching

---

⚔️ Built by Solomon

SolvaX MD – No Spam, Just Code.

"Strength does not ask twice."

---

© 2026 SolvaX MD. All rights reserved.
