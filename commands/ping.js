module.exports = async (context) => {
    const { sendReply } = context;
    await sendReply({ text: '🏓 Pong!\n\nBot is alive.' });
};