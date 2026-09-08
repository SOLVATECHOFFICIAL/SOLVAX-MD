'use strict';

const queues = new Map();

function enqueueCommand(task, key = 'global') {
  if (typeof task !== 'function') {
    return Promise.reject(new TypeError('Queue task must be a function.'));
  }

  const previous = queues.get(key) || Promise.resolve();
  const current = previous
    .catch(() => {})
    .then(() => task());

  let queued;
  queued = current.finally(() => {
    if (queues.get(key) === queued) {
      queues.delete(key);
    }
  });

  queues.set(key, queued);
  return queued;
}

function clearQueue(key) {
  queues.delete(key);
}

module.exports = { enqueueCommand, clearQueue };
