'use strict';
/**
 * The only bridge between the web UI and the main process. The UI can call the named requests below and
 * subscribe to the named events; nothing else from Electron or Node is exposed.
 */
const { contextBridge, ipcRenderer } = require('electron');

const REQUESTS = new Set([
  'accounts.list', 'accounts.presets', 'accounts.save', 'accounts.remove', 'accounts.test',
  'folders.list', 'folders.counts', 'folders.create', 'folders.rename', 'folders.delete',
  'messages.list', 'messages.unified', 'messages.get', 'messages.saveAttachment',
  'messages.setFlags', 'messages.move', 'messages.trash', 'messages.archive', 'messages.junk',
  'mail.send', 'mail.saveDraft', 'mail.deleteDraft',
  'calendars.list', 'calendars.save', 'calendars.remove', 'calendars.check', 'calendars.events', 'calendars.pickFile',
  'settings.get', 'settings.set',
  'contacts.search',
  'ai.getConfig', 'ai.setConfig', 'ai.draft', 'ai.resetUsage',
  'app.info', 'app.openExternal', 'app.checkNow',
  'compose.open', 'compose.init', 'compose.close'
]);

const EVENTS = new Set(['mail:new', 'mail:changed', 'mail:open', 'compose:request-close']);

contextBridge.exposeInMainWorld('classicmail', {
  invoke(name, ...args) {
    if (!REQUESTS.has(name)) return Promise.resolve({ ok: false, error: 'Unknown request.' });
    return ipcRenderer.invoke(`cm:${name}`, ...args);
  },
  on(event, callback) {
    if (!EVENTS.has(event) || typeof callback !== 'function') return () => {};
    const handler = (_e, payload) => callback(payload);
    ipcRenderer.on(`cm:${event}`, handler);
    return () => ipcRenderer.removeListener(`cm:${event}`, handler);
  },
  platform: process.platform
});
