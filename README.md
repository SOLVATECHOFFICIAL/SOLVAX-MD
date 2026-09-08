# ⚔️ SOLVAX MD v11

**Complete WhatsApp Bot** with 19 commands, anti-system, and Telegram pairing.

---

## 👑 Owner Info

| Item | Value |
| :--- | :--- |
| **Bot Name** | SOLVAX MD |
| **Owner** | Solomon |
| **Telegram Bot** | @solvax_mdbot |
| **Country** | Nigeria (234) |
| **Version** | v11.0.0 |

---

## 📋 Features

### 🔹 19 WhatsApp Commands
| Category | Count | Commands |
| :--- | :--- | :--- |
| Everyone | 8 | `.menu` `.ping` `.vv` `.play` `.video` `.sticker` `.lyrics` `.groupinfo` |
| Admin Force | 7 | `.tagall` `.tagadmin` `.add` `.kick` `.promote` `.demote` `.mute` (`.lock`/`.unlock`) |
| Anti-System | 4 | `.antilink` `.antimention` `.antiviewonce` `.antibot` |

### 🔹 5 Telegram Commands
`/start` `/help` `/pair` `/status` `/stop`

### 🔹 Core Systems
- **Database**: JSON file (survives restarts)
- **Queue**: First-come-first-serve processing
- **View-Once**: 5 decryption methods
- **Media**: 3 sources (YouTube + APIs)
- **Auto-Delete**: Loading messages disappear automatically
- **Private/Public**: Smart reply routing

---

## 🚀 Quick Start

### 1️⃣ Deploy to Railway (Recommended)

1. Fork this repo to your GitHub
2. Go to [railway.app](https://railway.app)
3. Click **"New Project"** → **"Deploy from GitHub repo"**
4. Select this repo
5. Add environment variable:
   - `BOT_TOKEN` = `8651480854:AAGvTXTzpopKVHAXFlHAYPblxTrEK5oHwco`
6. Deploy! 🎉

### 2️⃣ Deploy to Render (Free)

1. Fork this repo to your GitHub
2. Go to [render.com](https://render.com)
3. Click **"New +"** → **"Web Service"**
4. Connect your GitHub repo
5. Set:
   - Build Command: `npm install`
   - Start Command: `node index.js`
6. Add environment variable:
   - `BOT_TOKEN` = `8651480854:AAGvTXTzpopKVHAXFlHAYPblxTrEK5oHwco`
7. Deploy! 🎉

### 3️⃣ Keep Render Awake (Free)
- Sign up at [cron-job.org](https://cron-job.org)
- Create a cron job that pings your Render URL every 5 minutes
- Your bot stays awake 24/7

---

## 📱 How To Pair Your WhatsApp

1. Open Telegram: **@solvax_mdbot**
2. Send: `/pair 23409063285877`
3. Get your 8-digit pairing code
4. Open WhatsApp → **Linked Devices** → **Link with phone number**
5. Type the code
6. ✅ Connected!

---

## 🧠 Commands Guide

### 📜 Everyone Commands (8)
| Command | What it does | Reply |
| :--- | :--- | :--- |
| `.menu` | Shows full command list | Private |
| `.ping` | Checks if bot is alive | Private |
| `.vv` | Views view-once media | Private |
| `.play song` | Downloads MP3 | Public |
| `.video song` | Downloads MP4 | Public |
| `.sticker` | Converts to sticker | Private |
| `.lyrics song` | Fetches lyrics | Public |
| `.groupinfo` | Shows group stats | Private |

### 👑 Admin Commands (7)
| Command | What it does | Reply |
| :--- | :--- | :--- |
| `.tagall` | Mention everyone | Public |
| `.tagadmin` | Mention all admins | Public |
| `.add 234xxx` | Add number to group | Public |
| `.kick @tag` | Remove tagged person | Public |
| `.promote @tag` | Make admin | Public |
| `.demote @tag` | Remove admin | Public |
| `.mute on/off` | Close/open chat | Public |
| `.lock`/`.unlock` | Same as mute | Public |

### 🛡️ Anti-System (4)
| Command | Protects against | Reply |
| :--- | :--- | :--- |
| `.antilink` | Links in group | Private |
| `.antimention` | @all spam | Private |
| `.antiviewonce` | View-once messages | Private |
| `.antibot` | Other bots | Private |

**Anti-System Options:**
`on/off` `kick/delete/warn` `admin on/off` `warns <n>` `resetwarns` `clearwarns @tag`

---

## 📁 Project Structure
