'use strict';

// Import all command handlers
const menu = require('./menu');
const ping = require('./ping');
const vv = require('./vv');
const play = require('./play');
const video = require('./video');
const sticker = require('./sticker');
const lyrics = require('./lyrics');
const groupinfo = require('./groupinfo');
const tagall = require('./tagall');
const tagadmin = require('./tagadmin');
const add = require('./add');
const kick = require('./kick');
const promote = require('./promote');
const demote = require('./demote');
const mute = require('./mute');
const anti = require('./anti');

/**
 * Main WhatsApp command router.
 * Called by lib/whatsapp.js for each incoming message.
 *
 * @param {string} userId - The user's session ID
 * @param {object} session - The session object (socket, status, etc.)
 * @param {object} msg - The WhatsApp message object
 */
async function handleWhatsAppCommand(userId, session, msg) {
    const sock = session.socket;
    const jid = msg.key?.remoteJid;
    if (!jid || !sock) return;

    // Extract text and sender info
    const text = msg.message?.conversation ||
                 msg.message?.extendedTextMessage?.text ||
                 '';
    if (!text) return;

    const senderJid = msg.key?.participant || jid;
    const isGroup = jid.endsWith('@g.us');

    // Determine reply destination
    const publicCommands = ['.play', '.video', '.lyrics', '.tagall', '.tagadmin',
                           '.add', '.kick', '.promote', '.demote', '.mute', '.lock', '.unlock'];
    const command = text.split(' ')[0].toLowerCase();
    const isPublic = publicCommands.includes(command) && isGroup;
    const replyJid = isPublic ? jid : senderJid;

    // Helper to send reply
    const sendReply = async (content) => {
        await sock.sendMessage(replyJid, content);
    };

    const sendLoading = async (loadingText) => {
        if (!global.AUTO_DELETE_LOADING) {
            return sock.sendMessage(replyJid, { text: loadingText });
        }
        const loading = await sock.sendMessage(replyJid, { text: loadingText });
        setTimeout(async () => {
            try {
                await sock.sendMessage(replyJid, {
                    delete: { remoteJid: replyJid, fromMe: true, id: loading.key.id }
                });
            } catch (e) {}
        }, 2000);
        return loading;
    };

    // Build context object for command handlers
    const context = {
        sock,
        msg,
        sender: jid,
        senderNumber: senderJid.split('@')[0],
        isGroup,
        userId,
        replyJid,
        sendReply,
        sendLoading,
        rawText: text,
        text: command,
        // Helpers from global or lib
        jidNumber: (j) => j.split('@')[0],
        cleanNumber: (n) => String(n).replace(/\D/g, ''),
        fetchBuffer: require('../lib/helpers').fetchBuffer,
        sleep: require('../lib/helpers').sleep,
        // Admin checks
        isOwner: senderJid === global.OWNER_NUMBER + '@s.whatsapp.net' || (global.CO_OWNERS || []).includes(senderJid),
        getGroup: async () => {
            if (!isGroup) return null;
            try { return await sock.groupMetadata(jid); } catch { return null; }
        },
        isAdmin: async () => {
            if (!isGroup) return true;
            const group = await sock.groupMetadata(jid);
            const participant = group.participants.find(p => p.id === senderJid);
            return Boolean(participant?.admin) || context.isOwner;
        },
        getGroupAdmins: async () => {
            if (!isGroup) return [];
            const group = await sock.groupMetadata(jid);
            return group.participants.filter(p => p.admin).map(p => p.id);
        },
        getBotAdminStatus: async () => {
            if (!isGroup) return false;
            const group = await sock.groupMetadata(jid);
            const botId = sock.user?.id || (await sock.getMe())?.id;
            const participant = group.participants.find(p => p.id === botId);
            return Boolean(participant?.admin);
        }
    };

    // Route to specific command handler
    try {
        if (text === '.menu') return await menu(context);
        if (text === '.ping') return await ping(context);
        if (text === '.vv') return await vv(context);
        if (text.startsWith('.play ')) return await play(context);
        if (text.startsWith('.video ')) return await video(context);
        if (text === '.sticker') return await sticker(context);
        if (text.startsWith('.lyrics ')) return await lyrics(context);
        if (text === '.groupinfo') return await groupinfo(context);
        if (text === '.tagall') return await tagall(context);
        if (text === '.tagadmin') return await tagadmin(context);
        if (text.startsWith('.add ')) return await add(context);
        if (text.startsWith('.kick ')) return await kick(context);
        if (text.startsWith('.promote ')) return await promote(context);
        if (text.startsWith('.demote ')) return await demote(context);
        if (text === '.mute on' || text === '.lock') return await mute(context, 'on');
        if (text === '.mute off' || text === '.unlock') return await mute(context, 'off');
        if (text === '.antilink' || text.startsWith('.antilink ') ||
            text === '.antimention' || text.startsWith('.antimention ') ||
            text === '.antiviewonce' || text.startsWith('.antiviewonce ') ||
            text === '.antibot' || text.startsWith('.antibot ')) {
            return await anti(context);
        }
        // If no command matches, ignore.
    } catch (error) {
        console.error(`[COMMAND] Error handling ${command}:`, error);
        try {
            await sendReply({ text: `❌ Command failed: ${error.message || 'unknown error'}` });
        } catch (e) {}
    }
}

module.exports = { handleWhatsAppCommand };
