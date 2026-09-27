'use strict';
const net = require('net');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { spawn, execFileSync } = require('child_process');
const { SMTPServer } = require('smtp-server');
const { simpleParser } = require('mailparser');

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
    s.on('error', reject);
  });
}

function waitForPort(port, timeoutMs = 15000) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    (function attempt() {
      const sock = net.connect(port, '127.0.0.1');
      sock.once('connect', () => { sock.destroy(); resolve(); });
      sock.once('error', () => {
        sock.destroy();
        if (Date.now() - start > timeoutMs) reject(new Error(`port ${port} did not open`));
        else setTimeout(attempt, 150);
      });
    })();
  });
}

let writablePymapDir = null;

/**
 * pymap's built-in demo data marks Trash as read-only (a quirk of the fixture, not of real servers).
 * For ordinary tests we run pymap from a copy with that marker removed; the stock read-only
 * behaviour is kept available via startImap({ readonlyTrash: true }).
 */
function writablePymapPath() {
  if (writablePymapDir) return writablePymapDir;
  const src = execFileSync('python3', ['-c', 'import pymap,os;print(os.path.dirname(pymap.__file__))']).toString().trim();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'classicmail-pymap-'));
  fs.cpSync(src, path.join(root, 'pymap'), { recursive: true });
  const marker = path.join(root, 'pymap', 'backend', 'dict', 'demo', 'Trash', '.readonly');
  if (fs.existsSync(marker)) fs.rmSync(marker);
  writablePymapDir = root;
  return root;
}

/** In-memory IMAP server (pymap) with 4 demo messages in INBOX and Sent/Trash folders. */
async function startImap({ readonlyTrash = false } = {}) {
  const port = await freePort();
  const env = { ...process.env };
  if (!readonlyTrash) env.PYTHONPATH = writablePymapPath() + (env.PYTHONPATH ? path.delimiter + env.PYTHONPATH : '');
  const proc = spawn('pymap', ['--host', '127.0.0.1', '--port', String(port), '--no-tls', 'dict', '--demo-data'], { stdio: 'ignore', env });
  await waitForPort(port);
  return { port, user: 'demouser', pass: 'demopass', stop: () => proc.kill('SIGTERM') };
}

/** SMTP sink that records every accepted message. */
async function startSmtp({ requireAuth = true, rejectTo = [] } = {}) {
  const port = await freePort();
  const received = [];
  const server = new SMTPServer({
    authOptional: !requireAuth,
    disabledCommands: ['STARTTLS'],
    allowInsecureAuth: true,
    onAuth(auth, session, cb) {
      if (auth.username === 'demouser' && auth.password === 'demopass') cb(null, { user: auth.username });
      else cb(new Error('Invalid username or password'));
    },
    onRcptTo(address, session, cb) {
      if (rejectTo.includes(address.address.toLowerCase())) return cb(Object.assign(new Error('Mailbox unavailable'), { responseCode: 550 }));
      cb();
    },
    async onData(stream, session, cb) {
      const chunks = [];
      stream.on('data', c => chunks.push(c));
      stream.on('end', async () => {
        const raw = Buffer.concat(chunks);
        received.push({ envelope: session.envelope, raw, parsed: await simpleParser(raw) });
        cb();
      });
    }
  });
  await new Promise(r => server.listen(port, '127.0.0.1', r));
  return { port, received, stop: () => new Promise(r => server.close(r)) };
}

function tempDir(prefix = 'classicmail-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

const dummySecrets = {
  encrypt: s => `enc:${Buffer.from(s, 'utf8').toString('base64')}`,
  decrypt: s => Buffer.from(s.replace(/^enc:/, ''), 'base64').toString('utf8')
};

module.exports = { startImap, startSmtp, tempDir, dummySecrets, freePort, waitForPort };
