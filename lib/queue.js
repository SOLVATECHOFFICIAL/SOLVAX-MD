'use strict';
const queues = new Map();
function enqueueCommand(task, key='global') {
  if (typeof task !== 'function') return Promise.reject(new TypeError('Queue task must be a function.'));
  const k=String(key);
  const previous=queues.get(k)||Promise.resolve();
  const current=previous.catch(()=>{}).then(task);
  let queued;
  queued=current.finally(()=>{ if(queues.get(k)===queued) queues.delete(k); });
  queues.set(k,queued);
  return queued;
}
function clearQueue(key){queues.delete(String(key));}
module.exports={enqueueCommand,clearQueue};
