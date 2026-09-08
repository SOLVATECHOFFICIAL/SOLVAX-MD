const { Telegraf } = require('telegraf');
const fs = require('fs');
const config = JSON.parse(fs.readFileSync('./config.json', 'utf8'));

// Import modular pieces
const { loadDatabase, getAntiSettings, updateAntiSettings } = require('./lib/database');
const { sleep, cleanNumber, jidNumber, isLoggedOut, fetchBuffer, log } = require('./lib/helpers');
const { enqueueCommand } = require('./lib/queue');
const { createWhatsAppSession, attachMessageHandler } = require('./lib/whatsapp');

// Import Telegram commands
const startCommand = require('./telegram/start');
const helpCommand = require('./telegram/help');
const pairCommand = require('./telegram/pair');
const statusCommand = require('./telegram/status');
const stopCommand = require('./telegram/stop');

// Import WhatsApp command handlers
const handleMenu = require('./commands/menu');
const handlePing = require('./commands/ping');
const handleVv = require('./commands/vv');
const handlePlay = require('./commands/play');
const handleVideo = require('./commands/video');
const handleSticker = require('./commands/sticker');
const handleLyrics = require('./commands/lyrics');
const handleGroupInfo = require('./commands/groupinfo');
const handleTagAll = require('./commands/tagall');
const handleTagAdmin = require('./commands/tagadmin');
const handleAdd = require('./commands/add');
const handleKick = require('./commands/kick');
const handlePromote = require('./commands/promote');
const handleDemote = require('./commands/demote');
const handleMute = require('./commands/mute');
const handleAnti = require('./commands/anti');

// ============================================================
// CONFIGURATION
// ============================================================

const BOT_TOKEN = process.env.BOT_TOKEN;
const BOT_NAME = config.botName || 'SolvaX MD';
const OWNER_NAME = config.ownerName || 'Owner';
const OWNER_NUMBER = String(config.ownerNumber || '').replace(/\D/g, '');
const CO_OWNERS = Array.isArray(config.coOwners)
    ? config.coOwners.map(n => String(n).replace(/\D/g, ''))
    : [];
const AUTO_DELETE_LOADING = config.autoDeleteLoading !== undefined ? config.autoDeleteLoading : true;
const PLAY_SOURCES = config.playSources || 2;

if (!BOT_TOKEN) {
    console.error('❌ BOT_TOKEN environment variable is missing!');
    process.exit(1);
}

// ============================================================
// LOAD DATABASE
// ============================================================

loadDatabase();

// ============================================================
// TELEGRAM BOT
// ============================================================

const bot = new Telegraf(BOT_TOKEN);
const sessions = {};
const pairingStates = {};

// Make these available globally for telegram commands
global.bot = bot;
global.sessions = sessions;
global.pairingStates = pairingStates;
global.config = config;
global.BOT_NAME = BOT_NAME;
global.OWNER_NAME = OWNER_NAME;
global.OWNER_NUMBER = OWNER_NUMBER;
global.CO_OWNERS = CO_OWNERS;
global.AUTO_DELETE_LOADING = AUTO_DELETE_LOADING;
global.PLAY_SOURCES = PLAY_SOURCES;

// ============================================================
// TELEGRAM COMMANDS
// ============================================================

bot.start(startCommand);
bot.help(helpCommand);
bot.command('pair', pairCommand);
bot.command('status', statusCommand);
bot.command('stop', stopCommand);

// Handle number input for /pair (delegated to pair.js)
bot.on('text', async (ctx) => {
    const userId = ctx.from.id;
    if (!pairingStates[userId] || pairingStates[userId].step !== 'awaiting_number') return;

    // Import and run the pair handler dynamically
    const { handlePairText } = require('./telegram/pair');
    await handlePairText(ctx);
});

// ============================================================
// WHATSAPP MESSAGE HANDLER (Router)
// ============================================================

async function handleWhatsAppCommand(sock, msg, sender, senderNumber, isGroup, rawText, userId) {
    const text = rawText.toLowerCase();

    // Determine where to send reply
    const publicCommands = ['.play', '.video', '.lyrics', '.tagall', '.tagadmin', '.add', '.kick', '.promote', '.demote', '.mute', '.lock', '.unlock'];
    const command = text.split(' ')[0];
    const isPublic = publicCommands.includes(command) && isGroup;
    const replyJid = isPublic ? sender : (msg.key?.participant || sender);

    // Helper to send reply
    const sendReply = async (content) => {
        await sock.sendMessage(replyJid, content);
    };

    const sendLoading = async (loadingText) => {
        if (!AUTO_DELETE_LOADING) {
            return sock.sendMessage(replyJid, { text: loadingText });
        }
        const loading = await sock.sendMessage(replyJid, { text: loadingText });
        setTimeout(async () => {
            try {
                await sock.sendMessage(replyJid, { delete: { remoteJid: replyJid, fromMe: true, id: loading.key.id } });
            } catch (e) {}
        }, 2000);
        return loading;
    };

    // Check if user is admin (if needed)
    const isOwner = senderNumber === OWNER_NUMBER || CO_OWNERS.includes(senderNumber);
    const getGroup = async () => {
        if (!isGroup) return null;
        try { return await sock.groupMetadata(sender); } catch { return null; }
    };
    const isAdmin = async () => {
        if (!isGroup) return true;
        const group = await getGroup();
        if (!group) return false;
        const participant = group.participants.find(p => p.id === senderNumber + '@s.whatsapp.net') ||
                           group.participants.find(p => jidNumber(p.id) === senderNumber);
        return Boolean(participant?.admin || isOwner);
    };
    const getGroupAdmins = async () => {
        const group = await getGroup();
        if (!group) return [];
        return group.participants.filter(p => p.admin).map(p => p.id);
    };
    const getBotAdminStatus = async () => {
        const group = await getGroup();
        if (!group) return false;
        const botJid = sock.user?.id;
        if (!botJid) return false;
        const botNumber = jidNumber(botJid);
        const participant = group.participants.find(p => jidNumber(p.id) === botNumber);
        return Boolean(participant?.admin);
    };

    const context = {
        sock,
        msg,
        sender,
        senderNumber,
        isGroup,
        userId,
        replyJid,
        sendReply,
        sendLoading,
        isOwner,
        getGroup,
        isAdmin,
        getGroupAdmins,
        getBotAdminStatus,
        rawText,
        text,
        jidNumber,
        cleanNumber,
        fetchBuffer,
        sleep
    };

    // ========================================================
    // ROUTE TO SPECIFIC COMMAND HANDLERS
    // ========================================================

    if (text === '.menu') return handleMenu(context);
    if (text === '.ping') return handlePing(context);
    if (text === '.vv') return handleVv(context);
    if (text.startsWith('.play ')) return handlePlay(context);
    if (text.startsWith('.video ')) return handleVideo(context);
    if (text === '.sticker') return handleSticker(context);
    if (text.startsWith('.lyrics ')) return handleLyrics(context);
    if (text === '.groupinfo') return handleGroupInfo(context);
    if (text === '.tagall') return handleTagAll(context);
    if (text === '.tagadmin') return handleTagAdmin(context);
    if (text.startsWith('.add ')) return handleAdd(context);
    if (text.startsWith('.kick ')) return handleKick(context);
    if (text.startsWith('.promote ')) return handlePromote(context);
    if (text.startsWith('.demote ')) return handleDemote(context);
    if (text === '.mute on' || text === '.lock') return handleMute(context, 'on');
    if (text === '.mute off' || text === '.unlock') return handleMute(context, 'off');

    // Anti commands (all handled in one file)
    if (text === '.antilink' || text.startsWith('.antilink ') ||
        text === '.antimention' || text.startsWith('.antimention ') ||
        text === '.antiviewonce' || text.startsWith('.antiviewonce ') ||
        text === '.antibot' || text.startsWith('.antibot ')) {
        return handleAnti(context);
    }
}

// ============================================================
// WHATSAPP CONNECTION AND MESSAGE ROUTER
// ============================================================

// Attach the handler to new connections
global.handleWhatsAppCommand = handleWhatsAppCommand;

// ============================================================
// START BOT
// ============================================================

bot.launch({ dropPendingUpdates: true })
.then(() => {
    console.log('🤖 SolvaX MD Telegram bot running...');
    console.log('⚔️ SolvaX MD v11 is ready!');
    console.log(`📱 Owner: ${OWNER_NUMBER}`);
    console.log(`📚 Bot: ${BOT_NAME}`);
    console.log('🌐 Telegram bot connected.');
})
.catch(error => {
    console.error('❌ Telegram bot failed to start:', error);
});

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));