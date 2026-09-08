'use strict';
const fs = require('fs');
const path = require('path');
const P = require('pino');
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  Browsers,
  makeCacheableSignalKeyStore,
  fetchLatestBaileysVersion
} = require('@whiskeysockets/baileys');
const { cleanNumber, jidNumber, isGroupJid, sleep, getText } = require('./helpers');
const { enqueueCommand, clearQueue } = require('./queue');

const BASE_SESSION_DIR = path.resolve(process.env.WA_SESSION_DIR || path.join(process.cwd(), 'sessions'));
const PAIR_TIMEOUT = 10 * 60 * 1000;
const RECONNECT_BASE = 3000;
const RECONNECT_MAX = 30000;
const logger = P({ level: process.env.WA_LOG_LEVEL || 'silent' });

global.sessions ||= {};
global.pairingStates ||= {};
global.waReconnectTimers ||= {};
global.waConnectionLocks ||= {};
global.waCommandHandler ||= null;

function ensureSessionDirectory() { fs.mkdirSync(BASE_SESSION_DIR, { recursive: true }); }
function getSessionDirectory(id) { ensureSessionDirectory(); return path.join(BASE_SESSION_DIR, `wa_${String(id)}`); }
function removeDirectory(dir) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { console.error('[WhatsApp] auth cleanup failed:', e?.message || e); } }
function normalizePhoneNumber(n) { const v = cleanNumber(n); return v.length >= 10 && v.length <= 15 ? v : null; }
function getWhatsAppSession(id) { return global.sessions[String(id)] || null; }
function getPairingState(id) { return global.pairingStates[String(id)] || null; }
function clearPairingTimer(id) { const s = getPairingState(id); if (s?.timeout) clearTimeout(s.timeout); if (s) s.timeout = null; }
function clearReconnectTimer(id) { const t = global.waReconnectTimers[String(id)]; if (t) clearTimeout(t); delete global.waReconnectTimers[String(id)]; }
function closeSocket(sock) { try { sock?.ws?.close?.(); } catch (_) { } }
function acquireLock(id) { const k = String(id), now = Date.now(); if (global.waConnectionLocks[k] && now - global.waConnectionLocks[k] < 60000) return false; global.waConnectionLocks[k] = now; return true; }
function releaseLock(id) { delete global.waConnectionLocks[String(id)]; }
function formatPairingCode(code) { return String(code || '').replace(/\s/g, '').match(/.{1,4}/g)?.join('-') || null; }
function createPairingState(id, phone) { const s = { active: true, completed: false, cancelled: false, userId: String(id), phoneNumber: phone, pairingCode: null, startedAt: Date.now(), expiresAt: Date.now() + PAIR_TIMEOUT, timeout: null, socket: null, chatId: null }; global.pairingStates[String(id)] = s; s.timeout = setTimeout(() => expirePairing(id), PAIR_TIMEOUT); return s; }
async function expirePairing(id) { const k = String(id), s = getPairingState(k); if (!s || !s.active || s.completed) return; const session = getWhatsAppSession(k); if (session?.connected) return; console.log(`[WhatsApp] pairing expired for ${k}`); s.active = false; s.cancelled = true; clearPairingTimer(k); await stopWhatsAppSession(k, { deleteAuth: true, disableReconnect: true, clearPairing: true }); }
function setWhatsAppCommandHandler(fn) { if (typeof fn !== 'function') throw new TypeError('WhatsApp command handler must be a function'); global.waCommandHandler = fn; global.handleWhatsAppCommand = fn; return true; }
function getWhatsAppCommandHandler() { return typeof global.waCommandHandler === 'function' ? global.waCommandHandler : (typeof global.handleWhatsAppCommand === 'function' ? global.handleWhatsAppCommand : null); }

async function buildSocketOptions(state) {
  let version;
  try { const latest = await fetchLatestBaileysVersion(); if (Array.isArray(latest?.version)) version = latest.version; } catch (e) { console.warn('[WhatsApp] Could not fetch latest Baileys version; using installed version.'); }
  const opts = { auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, logger) }, logger, printQRInTerminal: false, browser: Browsers.ubuntu('Chrome'), markOnlineOnConnect: true, syncFullHistory: false, generateHighQualityLinkPreview: false };
  if (version) opts.version = version; return opts;
}
function createSession(id, sock, phone, reconnectAttempts = 0) { return { userId: String(id), socket: sock, phoneNumber: phone || jidNumber(sock?.user?.id), status: 'connecting', connected: false, stopping: false, reconnectEnabled: true, createdAt: Date.now(), lastConnectedAt: null, lastDisconnectAt: null, lastError: null, reconnectAttempts, pairingCode: null }; }

function getDisconnectStatusCode(lastDisconnect) { return lastDisconnect?.error?.output?.statusCode ?? lastDisconnect?.error?.statusCode ?? lastDisconnect?.error?.data?.statusCode ?? null; }
function isLoggedOutCode(code) { return code === DisconnectReason.loggedOut || code === 401; }

function attachSocketEvents(id, sock, saveCreds) {
  sock.ev.on('creds.update', async c => { try { await saveCreds(c); } catch (e) { console.error(`[WhatsApp] save creds ${id}:`, e?.message || e); } });
  sock.ev.on('connection.update', u => handleConnectionUpdate(id, sock, u).catch(e => console.error(`[WhatsApp] connection.update ${id}:`, e?.stack || e)));
  sock.ev.on('messages.upsert', u => handleIncomingMessages(id, sock, u).catch(e => console.error(`[WhatsApp] messages.upsert ${id}:`, e?.stack || e)));
}

async function createWhatsAppSession(userId, phoneNumber, options = {}) {
  const id = String(userId), phone = normalizePhoneNumber(phoneNumber);
  if (!phone) throw new Error('A valid WhatsApp phone number is required.');
  if (!acquireLock(id)) throw new Error('A WhatsApp connection is already being prepared.');
  let sock = null;
  try {
    clearReconnectTimer(id);
    const old = getWhatsAppSession(id);
    if (old) { old.stopping = true; old.reconnectEnabled = false; closeSocket(old.socket); delete global.sessions[id]; }
    if (options.fresh) removeDirectory(getSessionDirectory(id));
    fs.mkdirSync(getSessionDirectory(id), { recursive: true });
    const { state, saveCreds } = await useMultiFileAuthState(getSessionDirectory(id));
    const unregistered = !state.creds.registered;
    if (unregistered) { const p = createPairingState(id, phone); p.chatId = options.chatId || null; }
    sock = makeWASocket(await buildSocketOptions(state));
    const session = createSession(id, sock, phone);
    global.sessions[id] = session;
    const p = getPairingState(id); if (p) p.socket = sock;
    attachSocketEvents(id, sock, saveCreds);
    if (unregistered) {
      await sleep(2500);
      if (global.sessions[id]?.socket !== sock) throw new Error('WhatsApp pairing session was replaced.');
      const p2 = getPairingState(id); if (!p2?.active) throw new Error('WhatsApp pairing was cancelled or expired.');
      const code = await sock.requestPairingCode(phone);
      const formatted = formatPairingCode(code); if (!formatted) throw new Error('WhatsApp returned an invalid pairing code.');
      p2.pairingCode = formatted; session.pairingCode = formatted;
      return { socket: sock, pairingCode: formatted, phoneNumber: phone, userId: id };
    }
    return { socket: sock, pairingCode: null, phoneNumber: phone, userId: id };
  } catch (e) { if (sock) closeSocket(sock); if (global.sessions[id]?.socket === sock) delete global.sessions[id]; clearPairingTimer(id); if (options.fresh && !getWhatsAppSession(id)) removeDirectory(getSessionDirectory(id)); throw e; } finally { releaseLock(id); }
}

async function handleConnectionUpdate(id, sock, update) {
  const session = getWhatsAppSession(id); if (!session || session.socket !== sock) return;
  const { connection, lastDisconnect } = update || {};
  if (update?.isNewLogin) console.log(`[WhatsApp] ${id}: login accepted`);
  if (connection === 'connecting') { session.status = 'connecting'; session.connected = false; return; }
  if (connection === 'open') {
    session.status = 'connected'; session.connected = true; session.stopping = false; session.reconnectEnabled = true; session.lastConnectedAt = Date.now(); session.lastError = null; session.reconnectAttempts = 0; clearReconnectTimer(id);
    const p = getPairingState(id); if (p && p.socket === sock) { p.active = false; p.completed = true; p.pairingCode = session.pairingCode || p.pairingCode; clearPairingTimer(id); if (p.chatId && global.bot?.telegram) { try { await global.bot.telegram.sendMessage(p.chatId, `✅ WhatsApp connected successfully.\n\n📱 +${session.phoneNumber || 'Unknown'}\n🟢 Session is ready.`); } catch (e) { console.error('[WhatsApp] Telegram notify failed:', e?.message || e); } } }
    if (global.telegramPairingStates?.[id]) { const ts = global.telegramPairingStates[id]; if (ts.timeout) clearTimeout(ts.timeout); delete global.telegramPairingStates[id]; }
    console.log(`[WhatsApp] ${id}: connected`); return;
  }
  if (connection !== 'close') return;
  if (global.sessions[id]?.socket !== sock) return;
  session.connected = false; session.status = 'disconnected'; session.lastDisconnectAt = Date.now(); session.lastError = lastDisconnect?.error || null;
  const code = getDisconnectStatusCode(lastDisconnect); console.log(`[WhatsApp] ${id}: connection closed (${code})`);
  const deliberate = session.stopping || session.reconnectEnabled === false;
  if (deliberate) { delete global.sessions[id]; return; }
  if (isLoggedOutCode(code) || code === DisconnectReason.badSession) { session.reconnectEnabled = false; clearReconnectTimer(id); delete global.sessions[id]; removeDirectory(getSessionDirectory(id)); return; }
  scheduleReconnect(id);
}

function scheduleReconnect(id) { const k = String(id), s = getWhatsAppSession(k); if (!s || s.stopping || !s.reconnectEnabled || global.waReconnectTimers[k]) return; const attempt = (s.reconnectAttempts || 0) + 1; s.reconnectAttempts = attempt; s.status = 'reconnecting'; const delay = Math.min(RECONNECT_BASE * Math.min(attempt, 10), RECONNECT_MAX); console.log(`[WhatsApp] ${k}: reconnecting in ${delay}ms (attempt ${attempt})`); global.waReconnectTimers[k] = setTimeout(async () => { delete global.waReconnectTimers[k]; try { await reconnectWhatsAppSession(k); } catch (e) { console.error(`[WhatsApp] ${k}: reconnect failed:`, e?.message || e); scheduleReconnect(k); } }, delay); }

async function reconnectWhatsAppSession(id) { const k = String(id), old = getWhatsAppSession(k); if (!old || old.stopping || !old.reconnectEnabled) return null; if (!acquireLock(k)) return null; let sock = null; try {
    const phone = old.phoneNumber, attempts = old.reconnectAttempts || 0, dir = getSessionDirectory(k); closeSocket(old.socket); delete global.sessions[k];
    const { state, saveCreds } = await useMultiFileAuthState(dir); if (!state.creds.registered) throw new Error('Saved WhatsApp authentication is no longer registered.');
    sock = makeWASocket(await buildSocketOptions(state)); const s = createSession(k, sock, phone, attempts); global.sessions[k] = s; attachSocketEvents(k, sock, saveCreds); return sock;
  } catch (e) { if (sock) closeSocket(sock); if (!global.sessions[k]) global.sessions[k] = { ...old, status: 'reconnecting', connected: false, socket: null }; throw e; } finally { releaseLock(k); } }

async function stopWhatsAppSession(userId, { deleteAuth = false, disableReconnect = true, clearPairing = true } = {}) { const id = String(userId), s = getWhatsAppSession(id); clearReconnectTimer(id); if (s) { s.stopping = true; if (disableReconnect) s.reconnectEnabled = false; closeSocket(s.socket); delete global.sessions[id]; } if (clearPairing) { const p = getPairingState(id); if (p) { p.active = false; p.cancelled = true; clearPairingTimer(id); delete global.pairingStates[id]; } } if (deleteAuth) removeDirectory(getSessionDirectory(id)); clearQueue(id); return true; }
async function completelyResetUser(id) { return stopWhatsAppSession(id, { deleteAuth: true, disableReconnect: true, clearPairing: true }); }
async function cancelPairing(id) { return completelyResetUser(id); }
async function restoreWhatsAppSession(id) { const k = String(id), dir = getSessionDirectory(k); if (getWhatsAppSession(k) || !fs.existsSync(dir)) return null; try { const { state, saveCreds } = await useMultiFileAuthState(dir); if (!state.creds.registered) { removeDirectory(dir); return null; } const sock = makeWASocket(await buildSocketOptions(state)); const s = createSession(k, sock, jidNumber(state.creds.me?.id || state.creds.me?.jid)); global.sessions[k] = s; attachSocketEvents(k, sock, saveCreds); return sock; } catch (e) { console.error(`[WhatsApp] restore ${k} failed:`, e?.stack || e); return null; } }
async function restoreSessions() { ensureSessionDirectory(); for (const e of fs.readdirSync(BASE_SESSION_DIR, { withFileTypes: true })) { if (!e.isDirectory() || !e.name.startsWith('wa_')) continue; await restoreWhatsAppSession(e.name.slice(3)); await sleep(300); } }
async function stopAllWhatsAppSessions(opts = { deleteAuth: false }) { for (const id of Object.keys(global.sessions)) await stopWhatsAppSession(id, { deleteAuth: !!opts.deleteAuth, disableReconnect: true, clearPairing: true }); }

function isSelfMessage(msg) { return msg?.key?.fromMe === true; }
function getRemoteJid(msg) { return msg?.key?.remoteJid || null; }
function isIgnoredJid(jid) { return !jid || jid === 'status@broadcast' || jid.endsWith('@broadcast'); }
function extractMessageText(msg) { try { return getText(msg?.message || {}); } catch { return ''; } }
function getMessageText(msg) { return extractMessageText({ message: msg }); }

async function getGroupInfoForMessage(session, jid, msg) {
  if (!isGroupJid(jid)) return null;
  try { const metadata = await session.socket.groupMetadata(jid); const senderJid = msg?.key?.participant || jid; const sender = metadata.participants?.find(x => jidNumber(x.id) === jidNumber(senderJid)); const bot = metadata.participants?.find(x => jidNumber(x.id) === jidNumber(session.socket?.user?.id || '')); return { metadata, senderIsAdmin: Boolean(sender?.admin), botIsAdmin: Boolean(bot?.admin) }; } catch (e) { console.warn(`[WhatsApp] group metadata unavailable for ${jid}:`, e?.message || e); return null; }
}
function hasUrl(text) { return /(?:https?:\/\/|www\.|\b(?:[a-z0-9-]+\.)+(?:com|net|org|io|co|ng|me|xyz|app|dev)\b)/i.test(String(text || '')); }
function getMentionedJids(msg) { const m = msg?.message?.extendedTextMessage?.contextInfo || msg?.message?.imageMessage?.contextInfo || msg?.message?.videoMessage?.contextInfo || msg?.message?.documentMessage?.contextInfo || {}; return Array.isArray(m.mentionedJid) ? m.mentionedJid : []; }
async function enforceGroupSettings(id, session, msg, jid, text) {
  if (!isGroupJid(jid) || isSelfMessage(msg)) return false;
  const { getGroup, save } = require('./database'); const group = getGroup(jid); const anti = group?.anti || {}; const info = await getGroupInfoForMessage(session, jid, msg); if (!info || !info.botIsAdmin) return false;
  const checks = []; if (anti.antilink?.enabled && hasUrl(text)) checks.push(anti.antilink); if (anti.antimention?.enabled && getMentionedJids(msg).length) checks.push(anti.antimention); const raw = msg?.message || {}; if (anti.antiviewonce?.enabled && (raw.viewOnceMessage || raw.viewOnceMessageV2 || raw.viewOnceMessageV2Extension || raw.ephemeralMessage?.message?.viewOnceMessage || raw.ephemeralMessage?.message?.viewOnceMessageV2)) checks.push(anti.antiviewonce);
  for (const cfg of checks) { if (cfg.affectAdmins === false && info.senderIsAdmin) continue; const action = cfg.action || 'delete'; const sender = msg?.key?.participant; if (action === 'delete' || action === 'warn' || action === 'kick') { try { await session.socket.sendMessage(jid, { delete: msg.key }); } catch (e) { console.warn('[ANTI] delete failed:', e?.message || e); } } if (action === 'warn' && sender) { cfg.warns ||= {}; cfg.warns[sender] = (cfg.warns[sender] || 0) + 1; const n = cfg.warns[sender]; await session.socket.sendMessage(jid, { text: `⚠️ Warning ${n}/${cfg.maxWarns || 2}.` }); if (n >= (cfg.maxWarns || 2)) { try { await session.socket.groupParticipantsUpdate(jid, [sender], 'remove'); delete cfg.warns[sender]; } catch (e) { console.warn('[ANTI] kick failed:', e?.message || e); } } } else if (action === 'kick' && sender) { try { await session.socket.groupParticipantsUpdate(jid, [sender], 'remove'); } catch (e) { console.warn('[ANTI] kick failed:', e?.message || e); } } }
  if (checks.length) save(); return checks.length > 0;
}
async function handleIncomingMessages(id, sock, update) {
  const session = getWhatsAppSession(id); if (!session || session.socket !== sock) return;
  for (const msg of update?.messages || []) {
    try {
      const jid = getRemoteJid(msg);
      if (!jid || isIgnoredJid(jid) || !msg.message) continue;
      const text = extractMessageText(msg);
      if (await enforceGroupSettings(id, session, msg, jid, text)) continue;
      
      // ✅ FIX: Process ONLY user messages, skip bot's own messages.
      if (isSelfMessage(msg)) continue;   // <--- THIS WAS the bug (it was `if (!isSelfMessage(msg)) continue;`)
      
      if (!text) continue;
      await dispatchWhatsAppMessage(id, msg);
    } catch (e) { console.error(`[WhatsApp] message processing ${id}:`, e?.stack || e); }
  }
}
async function dispatchWhatsAppMessage(id, msg) { return enqueueCommand(async () => { const session = getWhatsAppSession(id); if (!session?.connected || session.stopping) return; const handler = getWhatsAppCommandHandler(); if (typeof handler !== 'function') throw new Error('No WhatsApp command handler is registered.'); try { await handler(id, session, msg); } catch (error) { console.error(`[WhatsApp] command failed for ${id}:`, error?.stack || error); const jid = msg?.key?.remoteJid; if (jid && session.connected) { try { await session.socket.sendMessage(jid, { text: `❌ Command failed: ${error?.message || 'unknown error'}` }); } catch (sendError) { console.error('[WhatsApp] failed sending command error:', sendError?.message || sendError); } } } }, id); }
async function sendMessage(id, jid, content, options = {}) { const s = getWhatsAppSession(id); if (!s?.socket) throw new Error('WhatsApp session not found.'); if (!s.connected) throw new Error('WhatsApp is not connected.'); return s.socket.sendMessage(jid, content, options); }
async function sendText(id, jid, text, options = {}) { return sendMessage(id, jid, { text: String(text) }, options); }
async function sendReply(id, jid, text, options = {}) { return sendText(id, jid, text, options); }
function isWhatsAppConnected(id) { return Boolean(getWhatsAppSession(id)?.connected); }
function getPairingCode(id) { return getPairingState(id)?.pairingCode || getWhatsAppSession(id)?.pairingCode || null; }
function getWhatsAppStatus(id) { const s = getWhatsAppSession(id), p = getPairingState(id); return { exists: !!s, connected: !!s?.connected, status: s?.status || null, phoneNumber: s?.phoneNumber || p?.phoneNumber || null, createdAt: s?.createdAt || p?.startedAt || null, reconnectAttempts: s?.reconnectAttempts || 0, pairing: !!p?.active, pairingCode: p?.pairingCode || s?.pairingCode || null }; }
module.exports = { createWhatsAppSession, restoreSessions, restoreWhatsAppSession, stopWhatsAppSession, stopAllWhatsAppSessions, completelyResetUser, cancelPairing, getWhatsAppSession, getPairingState, getPairingCode, getWhatsAppStatus, isWhatsAppConnected, setWhatsAppCommandHandler, getWhatsAppCommandHandler, getMessageText, getRemoteJid, isSelfMessage, isIgnoredJid, sendMessage, sendText, sendReply, dispatchWhatsAppMessage };
