const fs = require('fs');
const path = require('path');
const { Telegraf } = require('telegraf');
const config = require('./config.json');
const db = require('./lib/database');
const { commandParts, jidNumber, getMediaType } = require('./lib/helpers');
const { restoreSessions } = require('./lib/whatsapp');

const token = process.env.BOT_TOKEN || config.telegramToken;
if (!token) {
  console.error('Missing BOT_TOKEN. Add it as an environment variable.');
  process.exit(1);
}

const bot = new Telegraf(token);
global.bot = bot;
global.sessions = global.sessions || {};
global.pairingStates = global.pairingStates || {};
global.config = config;
global.db = db;

const telegramDir = path.join(__dirname, 'telegram');
bot.start(require(path.join(telegramDir, 'start')));
bot.help(require(path.join(telegramDir, 'help')));
bot.command('pair', require(path.join(telegramDir, 'pair')));
bot.command('status', require(path.join(telegramDir, 'status')));
bot.command('stop', require(path.join(telegramDir, 'stop')));

bot.on('text', async ctx => {
  const state = global.pairingStates[ctx.from.id];
  if (state?.step === 'awaiting_number' && !String(ctx.message.text).trim().startsWith('/')) {
    const { handlePairText } = require('./telegram/pair');
    return handlePairText(ctx);
  }
});

bot.catch((error, ctx) => console.error(`[TG:${ctx?.updateType}]`, error));

const commandDir = path.join(__dirname, 'commands');
const commands = new Map();
for (const file of fs.readdirSync(commandDir).filter(f => f.endsWith('.js'))) {
  try {
    const mod = require(path.join(commandDir, file));
    const name = path.basename(file, '.js').toLowerCase();
    const aliases = Array.isArray(mod.aliases) ? mod.aliases : [];
    commands.set(name, mod);
    for (const alias of aliases) commands.set(alias.toLowerCase(), mod);
  } catch (error) {
    console.error(`Failed loading ${file}:`, error.message);
  }
}

global.handleWhatsAppCommand = async (sock, msg, jid, senderNumber, isGroup, text, sessionUserId) => {
  const groupConfig = isGroup ? db.getGroup(jid) : null;
  if (isGroup && groupConfig?.antiLink && /(https?:\/\/|www\.)\S+/i.test(text) && !text.trim().startsWith(config.prefix || '.')) {
    try {
      const meta = await sock.groupMetadata(jid);
      const participant = meta.participants.find(p => String(p.id).split('@')[0].split(':')[0] === String(senderNumber));
      if (!participant?.admin) {
        await sock.sendMessage(jid, { delete: msg.key });
        return;
      }
    } catch {}
  }

  const parsed = commandParts(text, config.prefix || '.');
  if (!parsed) return;
  const command = commands.get(parsed.command);
  if (!command) return sock.sendMessage(jid, { text: `❌ Unknown command: ${parsed.command}\nUse .menu` }, { quoted: msg });

  const session = global.sessions[sessionUserId];
  if (isGroup && groupConfig?.muted) {
    try {
      const meta = await sock.groupMetadata(jid);
      const participant = meta.participants.find(p => String(p.id).split('@')[0].split(':')[0] === String(senderNumber));
      if (!participant?.admin && !((config.ownerIds || []).map(String).includes(String(sessionUserId)))) return;
    } catch {}
  }
  const cooldown = config.commandCooldownMs ?? 700;
  const now = Date.now();
  const key = `${sessionUserId}:${jid}:${senderNumber}`;
  global.commandCooldowns ||= new Map();
  const previous = global.commandCooldowns.get(key) || 0;
  if (now - previous < cooldown) return;
  global.commandCooldowns.set(key, now);

  const ctx = {
    sock,
    msg,
    jid,
    senderNumber,
    isGroup,
    args: parsed.args,
    text: parsed.text,
    command: parsed.command,
    sessionUserId,
    session,
    reply: content => sock.sendMessage(jid, typeof content === 'string' ? { text: content } : content, { quoted: msg }),
    send: (to, content, options) => sock.sendMessage(to, content, options),
    getMediaType: () => getMediaType(msg.message),
    isOwner: () => {
      const owners = (process.env.OWNER_IDS || config.ownerIds || []).map(String);
      return owners.includes(String(sessionUserId)) || owners.includes(String(senderNumber));
    }
  };

  try {
    await command(ctx);
  } catch (error) {
    console.error(`[CMD ${parsed.command}]`, error.stack || error);
    await ctx.reply(`❌ ${parsed.command} failed: ${error.message || 'Unexpected error'}`);
  }
};

(async () => {
  try {
    await bot.launch();
    console.log('🤖 SolvaX MD Telegram controller started.');
    await restoreSessions();
  } catch (error) {
    console.error('Startup failed:', error);
    process.exit(1);
  }
})();

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
