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
