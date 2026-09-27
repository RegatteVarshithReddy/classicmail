'use strict';
// Renders build/icon.svg to build/icon.png (512x512) with headless Chromium. Only needed if the SVG changes.
const fs = require('fs'); const path = require('path'); const { execFileSync } = require('child_process');
let chromium; try { ({ chromium } = require('playwright')); } catch (_) { ({ chromium } = require(path.join(execFileSync('npm', ['root', '-g']).toString().trim(), 'playwright'))); }
(async () => {
  const svg = fs.readFileSync(path.join(__dirname, '..', 'build', 'icon.svg'), 'utf8');
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: 512, height: 512 } });
  await p.setContent(`<style>html,body{margin:0;background:transparent}</style>${svg}`);
  await p.screenshot({ path: path.join(__dirname, '..', 'build', 'icon.png'), omitBackground: true });
  await b.close();
})();
