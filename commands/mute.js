module.exports = async (context, action) => {
    const { sock, sender, isGroup, sendReply, sendLoading, getBotAdminStatus } = context;

    if (!isGroup) {
        return sendReply({ text: '❌ Group only.' });
    }

    const botAdmin = await getBotAdminStatus();

    if (!botAdmin) {
        return sendReply({ text: '❌ Make the bot an admin first.' });
    }

    const isMuteOn = action === 'on';

    await sendLoading(isMuteOn ? '⏳ Closing chat...' : '⏳ Opening chat...');

    try {
        await sock.groupSettingUpdate(sender, isMuteOn ? 'announcement' : 'not_announcement');
        await sendReply({
            text: isMuteOn
                ? '🔒 Chat closed. Only admins can send messages.'
                : '🔓 Chat opened. Everyone can send messages.'
        });
    } catch (error) {
        await sendReply({ text: `❌ Failed: ${error.message}` });
    }
};