'use strict';
// Runs expandFeed off the main thread so a pathological recurrence rule can be cut off by a timeout.
const { parentPort, workerData } = require('worker_threads');
const { expandFeed } = require('./calendar');

try {
  const events = expandFeed(workerData.text, workerData.cal, workerData.from, workerData.to, {
    skip: new Set(workerData.skip || []),
    onStart: (key) => parentPort.postMessage({ type: 'start', key })
  });
  parentPort.postMessage({ type: 'done', events });
} catch (err) {
  parentPort.postMessage({ type: 'error', message: err && err.message ? err.message : String(err) });
}
