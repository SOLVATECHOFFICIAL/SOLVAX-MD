const queues = new Map();

function enqueueCommand(task, key = 'global') {
  const previous = queues.get(key) || Promise.resolve();
  const current = previous
    .catch(() => {})
    .then(() => task())
    .catch(error => console.error('[QUEUE]', error?.stack || error));
  queues.set(key, current.finally(() => {
    if (queues.get(key) === current) queues.delete(key);
  }));
  return current;
}

function clearQueue(key) {
  queues.delete(key);
}

module.exports = { enqueueCommand, clearQueue };
