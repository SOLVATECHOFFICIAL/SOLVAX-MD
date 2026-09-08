'use strict';

// Per-session serial queue. Supports both enqueueCommand(key, task)
// and the old enqueueCommand(task, key) signature for compatibility.
const queues = new Map();

function enqueueCommand(keyOrTask, taskOrKey) {
  let key;
  let task;
  if (typeof keyOrTask === 'function') {
    task = keyOrTask;
    key = taskOrKey ?? 'global';
  } else {
    key = String(keyOrTask ?? 'global');
    task = taskOrKey;
  }
  if (typeof task !== 'function') {
    return Promise.reject(new TypeError('Queue task must be a function.'));
  }
  const previous = queues.get(key) || Promise.resolve();
  const current = previous.catch(() => {}).then(task);
  let queued;
  queued = current.finally(() => {
    if (queues.get(key) === queued) queues.delete(key);
  });
  queues.set(key, queued);
  return queued;
}

function clearQueue(key) {
  queues.delete(String(key));
}

module.exports = { enqueueCommand, clearQueue };
