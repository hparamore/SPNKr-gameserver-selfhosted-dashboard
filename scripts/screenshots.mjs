// Capture the dashboard in every notable state, at 2x, into screenshots/.
//
//   npm run demo          # in one terminal
//   npm run screenshots   # in another
//
// Zero dependencies, same as design-check: the Windows host has nothing
// installed but Node. Chrome is driven over the DevTools Protocol using Node's
// built-in WebSocket (Node 22+), so there's no Puppeteer/Playwright install.

import { spawn } from 'child_process';
import { mkdirSync, writeFileSync, rmSync, existsSync, mkdtempSync } from 'fs';
import { join, dirname } from 'path';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(__dirname, '..', 'screenshots');
const URL_BASE = process.env.SPNKR_URL || 'http://localhost:8080';
const PORT = 9222;

const CHROME_CANDIDATES = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium'
];

const sleep = ms => new Promise(r => setTimeout(r, ms));

function findChrome() {
  const found = CHROME_CANDIDATES.find(p => existsSync(p));
  if (!found) {
    console.error('Could not find Chrome. Set CHROME_PATH or install Google Chrome.');
    process.exit(1);
  }
  return process.env.CHROME_PATH || found;
}

// --- Minimal CDP client -----------------------------------------------------

class CDP {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    ws.addEventListener('message', e => {
      const msg = JSON.parse(e.data);
      const resolver = this.pending.get(msg.id);
      if (resolver) {
        this.pending.delete(msg.id);
        msg.error ? resolver.reject(new Error(msg.error.message)) : resolver.resolve(msg.result);
      }
    });
  }

  send(method, params = {}) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }

  // Runs an expression in the page and waits for a returned promise to settle.
  async eval(expression) {
    const { result, exceptionDetails } = await this.send('Runtime.evaluate', {
      expression, awaitPromise: true, returnByValue: true
    });
    if (exceptionDetails) throw new Error(exceptionDetails.text || 'page evaluation failed');
    return result.value;
  }
}

async function connect() {
  // Chrome needs a moment before its debugging endpoint answers.
  for (let attempt = 0; attempt < 40; attempt++) {
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

// --- Capture ----------------------------------------------------------------

async function shot(cdp, name, { width = 1440, height = 1000, fullPage = false } = {}) {
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width, height, deviceScaleFactor: 2, mobile: width < 500
  });
  await sleep(450);   // let layout and any image decode settle

  const params = { format: 'png' };
  if (fullPage) {
    const { cssContentSize } = await cdp.send('Page.getLayoutMetrics');
    params.clip = { x: 0, y: 0, width: cssContentSize.width, height: cssContentSize.height, scale: 1 };
    params.captureBeyondViewport = true;
  }

  const { data } = await cdp.send('Page.captureScreenshot', params);
  const file = join(OUT_DIR, `${name}.png`);
  writeFileSync(file, Buffer.from(data, 'base64'));
  console.log(`  ${name}.png  (${width}x${height}${fullPage ? ', full page' : ''})`);
}

// Each entry sets the app into one state, then names the file to write.
const SCENES = [
  {
    name: '01-dashboard',
    note: 'Everything running, header images on',
    setup: `(async () => {
      showServerImages = true;
      await fetch('/api/settings', { method:'PUT', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ showServerImages: true }) });
      renderServers(cachedServers);
    })()`,
    opts: { fullPage: true }
  },
  {
    name: '02-dashboard-compact',
    note: 'Header images off — the dense view',
    setup: `(async () => {
      showServerImages = false;
      renderServers(cachedServers);
    })()`,
    opts: { fullPage: true }
  },
  {
    name: '03-configure',
    note: 'Consolidated per-server configuration',
    setup: `(async () => {
      showServerImages = true; renderServers(cachedServers);
      await openConfig('valheim'); await new Promise(r=>setTimeout(r,500));
    })()`
  },
  {
    name: '04-port-forwarding',
    note: 'Router setup instructions, deep-linked from the card chip',
    setup: `(async () => {
      closeModal();
      await openConfig('vrising','ports'); await new Promise(r=>setTimeout(r,700));
      document.getElementById('cfg-ports-section').scrollIntoView({block:'center'});
      await new Promise(r=>setTimeout(r,400));
    })()`
  },
  {
    name: '05-setup-agent-prompts',
    note: 'Setup panel with copy-paste prompts for a coding agent',
    setup: `(async () => {
      closeModal(); document.getElementById('setup-open').click();
      await new Promise(r=>setTimeout(r,400));
    })()`
  },
  {
    name: '06-view-options',
    note: 'Global image toggle and server ordering',
    setup: `(async () => {
      closeModal(); document.getElementById('reorder-open').click();
      await new Promise(r=>setTimeout(r,400));
    })()`
  },
  {
    name: '07-image-cropper',
    note: 'Built-in cropper, frame locked to the card aspect',
    setup: `(async () => {
      closeModal();
      await openConfig('valheim'); await new Promise(r=>setTimeout(r,300));
      const c=document.createElement('canvas'); c.width=1600; c.height=900;
      const x=c.getContext('2d');
      const g=x.createLinearGradient(0,0,0,620);
      g.addColorStop(0,'#1b3a5c'); g.addColorStop(.55,'#6b7fa3'); g.addColorStop(1,'#e0a86b');
      x.fillStyle=g; x.fillRect(0,0,1600,900);
      x.fillStyle='rgba(255,225,170,.95)'; x.beginPath(); x.arc(1180,470,78,0,7); x.fill();
      const hill=(t,col)=>{x.fillStyle=col;x.beginPath();x.moveTo(0,900);
        for(let i=0;i<=1600;i+=40)x.lineTo(i,t+Math.sin(i/210)*46+Math.cos(i/90)*16);
        x.lineTo(1600,900);x.closePath();x.fill();};
      hill(600,'#2f4a3a'); hill(680,'#233a2c'); hill(770,'#182a20');
      openCropper(c.toDataURL('image/jpeg',.9));
      await new Promise(r=>setTimeout(r,900));
    })()`
  },
  {
    name: '08-states-in-flight',
    note: 'Starting / stopping servers showing the travelling border',
    setup: `(async () => {
      closeModal();
      transitioning.set('palworld','running');
      transitioning.set('satisfactory','stopped');
      updating.add('enshrouded');
      renderServers(cachedServers);
      await new Promise(r=>setTimeout(r,700));
    })()`,
    opts: { fullPage: true }
  },
  {
    name: '09-link-lost',
    note: 'Socket dropped — stale values are flagged, not silently shown',
    setup: `(async () => {
      transitioning.clear(); updating.clear(); renderServers(cachedServers);
      document.body.classList.add('link-down');
      await new Promise(r=>setTimeout(r,300));
    })()`
  },
  {
    name: '10-empty-state',
    note: 'No servers configured yet',
    setup: `(async () => {
      document.body.classList.remove('link-down');
      renderServers([]);
      await new Promise(r=>setTimeout(r,300));
    })()`
  },
  {
    name: '11-mobile',
    note: 'Phone layout',
    setup: `(async () => {
      renderServers(cachedServers);
      await new Promise(r=>setTimeout(r,400));
    })()`,
    opts: { width: 414, height: 900, fullPage: true }
  }
];

// --- Main -------------------------------------------------------------------

const chromePath = findChrome();
mkdirSync(OUT_DIR, { recursive: true });

// Fail fast with a useful message rather than a blank page full of nothing.
try {
  const probe = await fetch(URL_BASE, { signal: AbortSignal.timeout(3000) });
  if (!probe.ok) throw new Error(`HTTP ${probe.status}`);
} catch (err) {
  console.error(`\n  ${URL_BASE} is not responding (${err.message}).`);
  console.error('  Start it first:  npm run demo\n');
  process.exit(1);
}

// Outside the repo. Chrome keeps writing to its profile for a moment after
// being killed, so a profile inside screenshots/ could survive cleanup and get
// committed — which is exactly what happened the first time this ran.
const profile = mkdtempSync(join(tmpdir(), 'spnkr-shots-'));
const chrome = spawn(chromePath, [
  '--headless=new',
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${profile}`,
  '--no-first-run',
  '--disable-gpu',
  '--hide-scrollbars',
  '--force-color-profile=srgb'
], { stdio: 'ignore' });

console.log(`\n  SPNKr — capturing ${SCENES.length} states from ${URL_BASE}\n`);

let cdp;
try {
  cdp = await connect();
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Page.navigate', { url: URL_BASE });
  await sleep(2500);           // socket connect + first poll

  for (const scene of SCENES) {
    try {
      await cdp.eval(scene.setup);
      await shot(cdp, scene.name, scene.opts);
    } catch (err) {
      console.error(`  FAILED ${scene.name}: ${err.message}`);
    }
  }

  console.log(`\n  Written to screenshots/\n`);
} finally {
  chrome.kill();
  try { rmSync(profile, { recursive: true, force: true }); } catch {}
}
