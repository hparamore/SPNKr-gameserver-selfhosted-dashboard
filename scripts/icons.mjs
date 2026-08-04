// Rasterise public/img/app-icon.svg into the PNGs an installed app needs.
//
//   npm run icons
//
// Why PNGs at all, when favicon.svg already exists: an SVG favicon covers the
// browser tab, but "Install this page as an app" (Chrome/Edge) reads the web
// app manifest, and iOS "Add to Home Screen" reads apple-touch-icon. Neither
// accepts SVG reliably, so without these you get the platform's fallback — a
// grey square with the first letter of the app name.
//
// Zero dependencies, same as design-check and screenshots: the Windows host has
// nothing installed but Node. Chrome is driven over the DevTools Protocol using
// Node's built-in WebSocket (Node 22+).

import { spawn } from 'child_process';
import { readFileSync, writeFileSync, existsSync, mkdtempSync, rmSync } from 'fs';
import { join, dirname } from 'path';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC = join(__dirname, '..', 'public');
const SOURCE = join(PUBLIC, 'img', 'app-icon.svg');
const PORT = 9223;                       // not 9222 — screenshots.mjs uses that

// name -> pixel size. 180 is what iOS asks for; 192 and 512 are the two sizes
// the manifest spec expects, 512 being what stores and task switchers enlarge.
const TARGETS = [
  ['apple-touch-icon.png', 180],
  ['icon-192.png', 192],
  ['icon-512.png', 512]
];

const CHROME_CANDIDATES = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium'
];

const sleep = ms => new Promise(r => setTimeout(r, ms));

function findChrome() {
  const found = process.env.CHROME_PATH || CHROME_CANDIDATES.find(p => existsSync(p));
  if (!found) {
    console.error('Could not find Chrome. Set CHROME_PATH or install Google Chrome.');
    process.exit(1);
  }
  return found;
}

class CDP {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    ws.addEventListener('message', e => {
      const msg = JSON.parse(e.data);
      const r = this.pending.get(msg.id);
      if (r) {
        this.pending.delete(msg.id);
        msg.error ? r.reject(new Error(msg.error.message)) : r.resolve(msg.result);
      }
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }
}

async function connect() {
  for (let i = 0; i < 40; i++) {
    try {
      const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const page = targets.find(t => t.type === 'page');
      if (page) {
        const ws = new WebSocket(page.webSocketDebuggerUrl);
        await new Promise((res, rej) => {
          ws.addEventListener('open', res, { once: true });
          ws.addEventListener('error', rej, { once: true });
        });
        return new CDP(ws);
      }
    } catch { /* not up yet */ }
    await sleep(250);
  }
  throw new Error('Chrome DevTools endpoint never came up');
}

// The SVG is inlined into a bare page with no margin so the viewport IS the
// icon — the screenshot needs no cropping and lands on exact pixel bounds.
function pageFor(svg, size) {
  const html = `<!doctype html><meta charset="utf-8">
<style>html,body{margin:0;padding:0;background:transparent}
svg{display:block;width:${size}px;height:${size}px}</style>${svg}`;
  return 'data:text/html;charset=utf-8,' + encodeURIComponent(html);
}

const svg = readFileSync(SOURCE, 'utf-8');
const profile = mkdtempSync(join(tmpdir(), 'spnkr-icons-'));
const chrome = spawn(findChrome(), [
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${profile}`,
  '--headless=new',
  '--hide-scrollbars',
  '--disable-gpu',
  '--no-first-run',
  '--no-default-browser-check',
  'about:blank'
], { stdio: 'ignore' });

try {
  const cdp = await connect();

  for (const [name, size] of TARGETS) {
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: size, height: size, deviceScaleFactor: 1, mobile: false
    });
    await cdp.send('Page.navigate', { url: pageFor(svg, size) });
    await sleep(300);   // let the SVG parse and paint

    const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' });
    const out = join(PUBLIC, name);
    writeFileSync(out, Buffer.from(data, 'base64'));
    console.log(`  ${name.padEnd(22)} ${size}x${size}`);
  }

  console.log('\nIcons written to public/.');
} finally {
  chrome.kill();
  // Chrome can still hold a lock on the profile for a moment after kill, and on
  // Windows that surfaces as EPERM. The icons are already written by here, so a
  // stray temp dir is not worth failing the run over.
  try { rmSync(profile, { recursive: true, force: true }); } catch {}
}
