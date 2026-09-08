let commandQueue = [];
let isProcessing = false;

function enqueueCommand(task) {
    commandQueue.push(task);
    processQueue();
}

async function processQueue() {
    if (isProcessing || commandQueue.length === 0) return;
    isProcessing = true;
    const task = commandQueue.shift();
    try {
        await task();
    } catch (error) {
        console.error('❌ Command error:', error.message);
    }
    isProcessing = false;
    setImmediate(processQueue);
}

module.exports = { enqueueCommand };