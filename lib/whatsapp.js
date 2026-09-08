const fs = require('fs');
const path = require('path');
const pino = require('pino');
const {
  default: makeWASocket,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  DisconnectReason,
  Browsers,
  makeCacheableSignalKeyStore
} = require('@whiskeysockets/baileys');
const { sleep, isLoggedOut, disconnectCode, jidNumber, getText } = require('./helpers');

const logger = pino({ level: process.env.LOG_LEVEL || 'silent' });
const sessions = global.sessions;

function sessionDir(userId) {
  return path.join(process.cwd(), 'sessions', `wa_${String(userId)}`);
}

function browserIdentity() {
  try { return Browsers.ubuntu('Chrome'); } catch { return ['Ubuntu', 'Chrome', '22.04.4']; }
}

async function buildSocket(userId, number, options = {}) {
  const dir = sessionDir(userId);
  fs.mkdirSync(dir, { recursive: true });
  const { state, saveCreds } = await useMultiFileAuthState(dir);

  let version;
  try {
    const latest = await fetchLatestBaileysVersion();
    version = latest.version;
  } catch {}

  const sock = makeWASocket({
    ...(version ? { version } : {}),
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, logger)
    },
    logger,
    browser: browserIdentity(),
    markOnlineOnConnect: false,
    syncFullHistory: false,
    generateHighQualityLinkPreview: false,
    connectTimeoutMs: 60000,
    defaultQueryTimeoutMs: 60000,
    keepAliveIntervalMs: 25000,
    retryRequestDelayMs: 250,
    printQRInTerminal: false
  });

  sock.ev.on('creds.update', saveCreds);

  const session = sessions[userId] || {
    userId,
    number,
    sock: null,
    saveCreds,
    connected: false,
    state: 'connecting',
    stopped: false,
    reconnecting: false,
    pairing: false,
    pairingCode: null,
    createdAt: Date.now()
  };
  session.sock = sock;
  session.saveCreds = saveCreds;
  session.number = number;
  session.stopped = false;
  session.state = 'connecting';
  session.pairing = false;
  session.pairingCode = null;
  sessions[userId] = session;

  attachEvents(userId, sock, number);
  return { sock, state, saveCreds, session };
}

function attachEvents(userId, sock, number) {
  sock.ev.on('connection.update', async update => {
    const session = sessions[userId];
    if (!session || session.sock !== sock) return;
    const { connection, lastDisconnect } = update;

    if (connection === 'connecting') {
      session.state = 'connecting';
    }

    if (connection === 'open') {
      session.connected = true;
      session.state = 'connected';
      session.reconnecting = false;
      session.pairing = false;
      console.log(`[WA] Connected ${number}`);
      if (global.bot) {
        try {
          await global.bot.telegram.sendMessage(userId,
            `✅ WhatsApp connected.\n\n📱 ${number}\n\nSend .menu on WhatsApp.`);
        } catch {}
      }
    }

    if (connection === 'close') {
      session.connected = false;
      const code = disconnectCode(lastDisconnect?.error);
      console.log(`[WA] Closed ${number}. code=${code ?? 'unknown'}`);

      if (isLoggedOut(lastDisconnect?.error) || session.stopped) {
        delete sessions[userId];
        try { await fs.promises.rm(sessionDir(userId), { recursive: true, force: true }); } catch {}
        if (global.bot) {
          try { await global.bot.telegram.sendMessage(userId, `🔴 WhatsApp session logged out.\n\nUse /pair to link again.`); } catch {}
        }
        return;
      }

      if (session.reconnecting) return;
      session.reconnecting = true;
      session.state = 'reconnecting';
      await sleep(3000);
      if (!sessions[userId] || sessions[userId].stopped) return;

      try {
        await createWhatsAppSession(userId, number, null, { pairing: false, reconnect: true });
      } catch (error) {
        console.error(`[WA] Reconnect failed for ${number}:`, error.message);
        session.reconnecting = false;
      }
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;
    for (const msg of messages || []) {
      if (!msg?.message || msg.key?.fromMe) continue;
      const remoteJid = msg.key.remoteJid;
      if (!remoteJid || remoteJid === 'status@broadcast') continue;
      const isGroup = remoteJid.endsWith('@g.us');
      const senderJid = msg.key.participant || remoteJid;
      const senderNumber = jidNumber(senderJid);
      const text = getText(msg.message);
      if (!text) continue;
      msg._sessionUserId = userId;
      console.log(`[MSG:${number}] ${senderNumber}: ${text.slice(0, 120)}`);
      const { enqueueCommand } = require('./queue');
      enqueueCommand(
        () => global.handleWhatsAppCommand(sock, msg, remoteJid, senderNumber, isGroup, text, userId),
        userId
      );
    }
  });
}

async function createWhatsAppSession(userId, number, ctx = null, options = {}) {
  const existing = sessions[userId];
  if (existing?.sock && (existing.connected || existing.state === 'connecting' || existing.state === 'reconnecting')) {
    if (options.pairing && !existing.connected && !existing.pairing) {
      return requestPairingCode(userId, number, ctx);
    }
    return existing;
  }

  const built = await buildSocket(userId, number, options);
  if (options.pairing && !built.state.creds.registered) {
    return requestPairingCode(userId, number, ctx);
  }
  return built.session;
}

async function requestPairingCode(userId, number, ctx = null) {
  const session = sessions[userId];
  if (!session?.sock) throw new Error('WhatsApp socket is not ready.');
  if (session.pairingCode) return session.pairingCode;
  session.pairing = true;

  let lastError;
  // WhatsApp expects the pairing request after the socket has begun connecting.
  // Do not hammer requestPairingCode: repeated concurrent requests can corrupt pairing state.
  if (session.state !== 'connecting' && session.state !== 'pairing') {
    await sleep(1500);
  }
  await sleep(1200);
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      if (attempt > 1) await sleep(2500);
      const code = await session.sock.requestPairingCode(number);
      session.pairingCode = code;
      session.state = 'pairing';
      console.log(`[WA] Pairing code for ${number}: ${code}`);
      if (ctx) {
        await ctx.reply(
          `🔑 PAIRING CODE\n\n${code}\n\n` +
          `WhatsApp → Linked Devices → Link a device → Link with phone number.\n\n` +
          `Enter the code exactly as shown. Do not request another code while using this one.`
        );
      }
      return code;
    } catch (error) {
      lastError = error;
      console.error(`[WA] Pairing attempt ${attempt} failed:`, error.message);
    }
  }

  session.pairing = false;
  throw lastError || new Error('Could not generate pairing code.');
}

async function stopWhatsAppSession(userId, removeFiles = false) {
  const session = sessions[userId];
  if (session) {
    session.stopped = true;
    try { session.sock?.end?.(new Error('Stopped by user')); } catch {}
    delete sessions[userId];
  }
  if (removeFiles) {
    try { await fs.promises.rm(sessionDir(userId), { recursive: true, force: true }); } catch {}
  }
}

async function restoreSessions() {
  const root = path.join(process.cwd(), 'sessions');
  fs.mkdirSync(root, { recursive: true });
  const entries = await fs.promises.readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith('wa_')) continue;
    const userId = entry.name.slice(3);
    try {
      const dir = path.join(root, entry.name);
      const { state } = await useMultiFileAuthState(dir);
      if (!state.creds.registered) continue;
      const number = jidNumber(state.creds.me?.id || '');
      if (!number) continue;
      await createWhatsAppSession(userId, number, null, { pairing: false, restore: true });
      console.log(`[WA] Restored session ${userId} (${number})`);
    } catch (error) {
      console.error(`[WA] Failed to restore ${entry.name}:`, error.message);
    }
  }
}

module.exports = {
  createWhatsAppSession,
  requestPairingCode,
  stopWhatsAppSession,
  restoreSessions,
  sessionDir
};
