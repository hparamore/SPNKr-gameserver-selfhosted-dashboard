// Design conformance check — makes ART-DIRECTION.md enforceable.
//
//   npm run design-check
//
// ART-DIRECTION.md ends with an anti-default checklist that a human is supposed
// to tick off "before calling any UI done". Humans don't. Six months from now a
// 16px radius creeps back in through one component and nobody notices, because
// nothing in the repo can tell the difference between a deliberate exception
// and a regression.
//
// This turns that checklist into rules the build can fail on. Each rule cites
// the section of ART-DIRECTION.md it enforces, so a failure sends you to the
// spec rather than to a lint config. If the spec changes, change the rule and
// say so in the commit — the two are meant to move together.
//
// Deliberate exceptions are marked in the source with a trailing
//   /* design-check: allow <rule-id> — <reason> */
// on the offending line. The reason is required; an unexplained allow fails.
//
// Zero dependencies on purpose. This has to run on a Windows box with nothing
// installed but Node.

import { readFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join, relative } from 'path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const rel = (p) => relative(root, p).replace(/\\/g, '/');

/* ── Source loading ──────────────────────────────────────────────────────── */

// Blank out comments while preserving line numbers, so reported lines match the
// real file and commented-out examples don't trip rules. (ART-DIRECTION.md's
// own prose is quoted in the CSS header — without this, every rule would flag
// the file that documents them.)
function stripComments(text, kind) {
  const pattern = kind === 'css' ? /\/\*[\s\S]*?\*\//g : /\/\*[\s\S]*?\*\/|\/\/[^\n]*/g;
  return text.replace(pattern, (m) => m.replace(/[^\n]/g, ' '));
}

function load(path, kind) {
  if (!existsSync(path)) return null;
  const raw = readFileSync(path, 'utf8');
  const code = stripComments(raw, kind);
  return { path, raw, code, lines: code.split('\n') };
}

const css = load(join(root, 'public/css/styles.css'), 'css');
const html = load(join(root, 'public/index.html'), 'html');
const js = load(join(root, 'public/js/app.js'), 'js');
const favicon = load(join(root, 'public/favicon.svg'), 'html');

if (!css) {
  console.error('design-check: public/css/styles.css not found. Run from the repo root.');
  process.exit(2);
}

/* ── Allow-list ──────────────────────────────────────────────────────────── */

// A line may opt out of one rule, with a stated reason. Reasons are printed in
// the report so exceptions stay visible instead of silently accumulating.
const ALLOW = /design-check:\s*allow\s+([a-z0-9-]+)\s*(?:—|--|-)\s*(.+?)\s*(?:\*\/|$)/;
const exemptions = [];

function exemptedFrom(file, lineNo, ruleId) {
  const line = file.raw.split('\n')[lineNo - 1] || '';
  const m = line.match(ALLOW);
  if (!m || m[1] !== ruleId) return false;
  exemptions.push({ file: rel(file.path), line: lineNo, rule: ruleId, reason: m[2] });
  return true;
}

// Walk a file's lines, reporting every match of `pattern` that isn't exempted.
function scan(file, ruleId, pattern, describe) {
  const out = [];
  if (!file) return out;
  file.lines.forEach((text, i) => {
    const lineNo = i + 1;
    for (const m of text.matchAll(pattern)) {
      if (exemptedFrom(file, lineNo, ruleId)) return;
      out.push({ file: rel(file.path), line: lineNo, detail: describe(m, text.trim()) });
    }
  });
  return out;
}

/* ── Token table ─────────────────────────────────────────────────────────── */

const tokens = {};
for (const [, name, value] of css.code.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)) {
  tokens[name] = value.trim();
}

/* ── WCAG contrast ───────────────────────────────────────────────────────── */

function toRgb(hex) {
  const h = hex.replace('#', '');
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  return [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16));
}

function luminance(hex) {
  const [r, g, b] = toRgb(hex).map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(fg, bg) {
  const [a, b] = [luminance(fg), luminance(bg)].sort((x, y) => y - x);
  return (a + 0.05) / (b + 0.05);
}

/* ── Rules ───────────────────────────────────────────────────────────────── */
//
// severity: 'fail'  — violates the spec outright; exits non-zero
//           'warn'  — worth a look, not a blocker

const rules = [
  {
    id: 'no-shadow',
    spec: 'Finish — "Depth: borders only. Zero box-shadow in the entire stylesheet."',
    severity: 'fail',
    run: () => scan(css, 'no-shadow', /box-shadow\s*:/g, () =>
      'box-shadow declared; elevation must come from rule weight and surface value'),
  },
  {
    id: 'radius-2px',
    spec: 'Finish — "Corners: 2px." The 16px radius is the biggest soft-SaaS tell.',
    severity: 'fail',
    run: () => {
      const max = parseFloat(tokens['--radius'] ?? '2');
      const findings = [];
      if (max > 2) {
        findings.push({
          file: rel(css.path), line: 0,
          detail: `--radius is ${tokens['--radius']}; spec caps it at 2px`,
        });
      }
      findings.push(...scan(css, 'radius-2px', /border-radius\s*:\s*([^;]+)/g, (m) => {
        const value = m[1].trim();
        if (/var\(--radius/.test(value)) return null;
        // Every explicit length in the value must be <= 2px. Percentages and
        // `50%` are the tube mark's circle — allowed only in the mark itself,
        // which is checked by the tube-mark rule instead.
        const bad = [...value.matchAll(/(\d*\.?\d+)px/g)]
          .map((n) => parseFloat(n[1]))
          .filter((n) => n > 2);
        return bad.length ? `border-radius: ${value} — exceeds the 2px cap` : null;
      }).filter((f) => f.detail));
      return findings;
    },
  },
  {
    id: 'no-loop-motion',
    spec: 'Motion — "Forbidden outright: infinite/looping animations of any kind." '
        + 'The dashboard lives on a second monitor; movement at rest reads as a state change.',
    severity: 'fail',
    run: () => [
      ...scan(css, 'no-loop-motion', /\binfinite\b/g, () =>
        'infinite animation; nothing may move while state is unchanged'),
      // Capture the value rather than negative-lookahead past it: `\s*(?!1)`
      // happily matches zero spaces and then asserts "not a 1" against the
      // space itself, which flags every correct `: 1` in the file.
      ...scan(css, 'no-loop-motion', /animation-iteration-count\s*:\s*([^;!}]+)/g, (m) => {
        const count = m[1].trim();
        return count === '1' ? null
          : `animation-iteration-count: ${count} — only the relay flash may play, once, on state change`;
      }).filter((f) => f.detail),
    ],
  },
  {
    id: 'no-card-transform',
    spec: 'Motion — "hover:scale or any transform on cards" is forbidden.',
    severity: 'fail',
    run: () => {
      const out = [];
      // Look for a transform inside any rule whose selector mentions a card and
      // a hover state — the specific pattern the spec names.
      for (const m of css.code.matchAll(/([^{}]*:hover[^{}]*)\{([^}]*)\}/g)) {
        const [selector, body] = [m[1].trim(), m[2]];
        if (!/card|plate|tile/i.test(selector)) continue;
        if (!/transform\s*:\s*(?!none)/.test(body)) continue;
        const line = css.code.slice(0, m.index).split('\n').length;
        if (exemptedFrom(css, line, 'no-card-transform')) continue;
        out.push({ file: rel(css.path), line, detail: `${selector} applies a transform on hover` });
      }
      return out;
    },
  },
  {
    id: 'no-glass',
    spec: 'Finish — "No glassmorphism, no backdrop blur, no gradient fills on surfaces."',
    severity: 'fail',
    run: () => scan(css, 'no-glass', /backdrop-filter\s*:|filter\s*:\s*blur/g, () =>
      'backdrop blur / glassmorphism'),
  },
  {
    id: 'no-side-stripe',
    spec: 'Finish — a coloured border on ONE side, thicker than the hairline, is the single '
        + 'most recognisable tell of generated UI. State is keyed on the full border, the '
        + 'surface value and the tube readout instead. Cards and toasts both shipped with a '
        + '3px left stripe and both were rewritten.',
    severity: 'fail',
    // 2px and up only. 1px border-left/right is legitimate structure — the
    // topbar cells, stat columns and tool buttons are all divided that way.
    run: () => scan(
      css,
      'no-side-stripe',
      /border-(left|right)\s*:\s*(?:[2-9]|\d{2,})px/g,
      (m) => `${m[0]} — side stripe; key the full border instead`,
    ),
  },
  {
    id: 'three-hues',
    spec: 'Color — "Three semantic hues. No more." Indigo, purple and blue are deleted, not re-tinted.',
    severity: 'fail',
    run: () => {
      const banned = /#6c63ff|--purple|--blue\b|--indigo|--green\b|--red\b|--yellow\b/gi;
      return scan(css, 'three-hues', banned, (m) => `${m[0]} — deleted from the palette`);
    },
  },
  {
    id: 'tokens-only',
    spec: 'Color — the token table is the palette. A raw hex outside :root is a colour '
        + 'nobody measured for contrast.',
    severity: 'warn',
    run: () => {
      const rootBlock = css.code.match(/:root\s*\{[\s\S]*?\}/)?.[0] ?? '';
      const rootStart = css.code.indexOf(rootBlock);
      const rootEnd = rootStart + rootBlock.length;
      const out = [];
      for (const m of css.code.matchAll(/#[0-9a-f]{3,8}\b/gi)) {
        if (m.index >= rootStart && m.index < rootEnd) continue;
        const line = css.code.slice(0, m.index).split('\n').length;
        if (exemptedFrom(css, line, 'tokens-only')) continue;
        out.push({ file: rel(css.path), line, detail: `raw ${m[0]} outside :root — use a token` });
      }
      return out;
    },
  },
  {
    id: 'contrast-aa',
    spec: 'Color — "Every foreground/background pair has been measured against WCAG AA (4.5:1) '
        + 'on the darkest surface it can appear on."',
    severity: 'fail',
    run: () => {
      const inks = ['--ink', '--ink-dim', '--ink-mute', '--amber', '--ok', '--fault'];

      // Surfaces every ink inherits onto: the page ground, the card plate, and
      // the recessed rows inside it. Text lands on these without any rule
      // saying so, so each ink must clear AA on all of them.
      //
      // --shell-600 is deliberately NOT here. The token table calls it
      // "Raised / hover" — it is only ever a hover background, and the hover
      // rules promote text to --ink at the same time. Grading every ink
      // against it would flag a pairing that never renders. Explicit pairings
      // below catch it if that ever stops being true.
      const inherited = ['--shell-900', '--shell-800', '--shell-750', '--shell-700']
        .filter((t) => tokens[t]);

      // Any block that sets both a colour and a background states a pairing
      // outright — measure those too, whatever surface they name.
      const paired = {};
      for (const m of css.code.matchAll(/\{([^}]*)\}/g)) {
        const body = m[1];
        const ink = body.match(/(?:^|[\s;])color\s*:\s*var\((--ink[a-z-]*|--amber|--ok|--fault)\)/)?.[1];
        const surface = body.match(/background(?:-color)?\s*:\s*[^;]*var\((--shell-[0-9]+)\)/)?.[1];
        if (!ink || !surface) continue;
        (paired[ink] ??= new Set()).add(surface);
      }

      const out = [];
      for (const ink of inks) {
        const fg = tokens[ink];
        if (!fg || !/^#[0-9a-f]{3,8}$/i.test(fg)) continue;

        const surfaces = new Set([...inherited, ...(paired[ink] ?? [])]);

        // Report the worst pairing. For light ink on dark shells the worst case
        // is the *lightest* surface, not the darkest — so take the minimum
        // ratio rather than assuming which end of the scale is hardest.
        let worst = null;
        for (const surface of surfaces) {
          const bg = tokens[surface];
          if (!bg || !/^#[0-9a-f]{3,8}$/i.test(bg)) continue;
          const ratio = contrast(fg, bg);
          if (!worst || ratio < worst.ratio) worst = { surface, bg, ratio };
        }
        if (worst && worst.ratio < 4.5) {
          out.push({
            file: rel(css.path), line: 0,
            detail: `${ink} ${fg} on ${worst.surface} ${worst.bg} = ${worst.ratio.toFixed(2)}:1 `
                  + '(AA body text needs 4.5:1)',
          });
        }
      }
      return out;
    },
  },
  {
    id: 'reduced-motion',
    spec: 'Motion — "All motion inside @media (prefers-reduced-motion: no-preference)."',
    severity: 'warn',
    run: () => {
      if (/prefers-reduced-motion/.test(css.code)) return [];
      if (!/@keyframes|animation\s*:/.test(css.code)) return [];
      return [{
        file: rel(css.path), line: 0,
        detail: 'animations declared but no prefers-reduced-motion guard in the stylesheet',
      }];
    },
  },
  {
    id: 'semantic-type',
    spec: 'Type — "if a human wrote it, it\'s Barlow; if a machine emitted it, it\'s Plex Mono." '
        + 'A default system stack means neither decision was made.',
    severity: 'fail',
    run: () => scan(css, 'semantic-type',
      /font-family\s*:\s*(?!var\(|'Barlow|'IBM)([^;]*(?:Inter|-apple-system|Helvetica|Arial\b(?! Narrow))[^;]*)/g,
      (m) => `default sans stack "${m[1].trim()}" — use var(--display) or var(--mono)`),
  },
  {
    id: 'self-hosted-fonts',
    spec: 'Type — "Both self-hosted as woff2 ... works on a LAN with no internet."',
    severity: 'fail',
    run: () => {
      const out = [];
      for (const file of [css, html].filter(Boolean)) {
        out.push(...scan(file, 'self-hosted-fonts',
          /(?:fonts\.googleapis|fonts\.gstatic|use\.typekit|cdn\.jsdelivr[^\s"']*font)/g,
          (m) => `external font request to ${m[0]} — the dashboard must render on an offline LAN`));
      }
      return out;
    },
  },
  {
    id: 'tube-mark',
    spec: 'Signature move — "the mark\'s geometry recurs as the status indicator on every '
        + 'card — two bars, staggered diagonally to echo the offset of the bores." If the '
        + 'readout loses the stagger, or the mark only appears in the topbar, the signature '
        + 'move is gone.',
    severity: 'warn',
    run: () => {
      if (!favicon) {
        return [{ file: 'public/favicon.svg', line: 0, detail: 'tube mark favicon missing' }];
      }
      const out = [];

      // The mark must keep its two defining traits: diagonally offset bores
      // (two circles at different centres) knocked out of a solid housing.
      const bores = (favicon.code.match(/a5\.4 5\.4 0|circle/g) || []).length;
      if (bores < 2) {
        out.push({
          file: 'public/favicon.svg', line: 0,
          detail: 'mark no longer shows two distinct bores',
        });
      }

      // The status readout is the bar derivation of the mark. Its absence from
      // the stylesheet means cards fell back to a generic dot.
      const hasReadout = /tube|status-bar|state-bar|status-field/i.test(css.code);
      if (!hasReadout) {
        out.push({
          file: rel(css.path), line: 0,
          detail: 'no tube-derived status readout found; the mark must double as the instrument',
        });
      }

      // The diagonal stagger is the whole link back to the mark. Level bars are
      // a generic pair and the signature is lost.
      if (hasReadout && !/\.tube:last-child\s*{[^}]*margin-top/.test(css.code)) {
        out.push({
          file: rel(css.path), line: 0,
          detail: 'status bars are level — the diagonal stagger that echoes the bores is missing',
        });
      }

      if (/\.status-dot\b/.test(css.code)) {
        out.push({
          file: rel(css.path), line: 0,
          detail: '.status-dot present — the 8px dot was replaced by a filled field and two bars',
        });
      }
      return out;
    },
  },
  {
    id: 'state-hues-reserved',
    spec: 'Color — "--ok and --fault are reserved exclusively for run state and never used '
        + 'decoratively."',
    severity: 'warn',
    run: () => {
      const out = [];
      // Find every rule block that references --ok or --fault, and check the
      // selector actually concerns run state.
      for (const m of css.code.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
        const [selector, body] = [m[1].trim().split('\n').pop().trim(), m[2]];
        if (!/var\(--(?:ok|fault)/.test(body)) continue;
        // Run-state selectors, plus the two the spec blesses by name: "Start and
        // Stop sit neutral at rest and take their colour only on hover/focus."
        const isRunState = /running|stopped|crash|fault|error|offline|online|state|status|ok\b|down\b|:root|starting/i.test(selector)
          || /\.btn-(?:go|halt)\b|\.(?:start|stop|restart)-/i.test(selector);
        if (isRunState) continue;
        const line = css.code.slice(0, m.index).split('\n').length;
        if (exemptedFrom(css, line, 'state-hues-reserved')) continue;
        out.push({
          file: rel(css.path), line,
          detail: `${selector} uses a run-state hue but isn't a run-state selector`,
        });
      }
      return out;
    },
  },
  {
    id: 'label-tracking',
    spec: 'Type — "Micro-labels get 0.18em tracking — stencil spacing."',
    severity: 'warn',
    run: () => {
      const uppercased = [...css.code.matchAll(/([^{}]+)\{([^}]*text-transform\s*:\s*uppercase[^}]*)\}/g)];
      const out = [];
      for (const m of uppercased) {
        const [selector, body] = [m[1].trim().split('\n').pop().trim(), m[2]];
        if (/letter-spacing/.test(body)) continue;
        const line = css.code.slice(0, m.index).split('\n').length;
        if (exemptedFrom(css, line, 'label-tracking')) continue;
        out.push({
          file: rel(css.path), line,
          detail: `${selector} is uppercased with no letter-spacing — uppercase without tracking reads as shouting, not stencilling`,
        });
      }
      return out;
    },
  },
  {
    id: 'no-title-only-labels',
    spec: 'Accessibility — every icon-only control needs an accessible name. '
        + '(Hunter\'s standing rule: accessibility is a default, not a stretch goal.)',
    severity: 'fail',
    run: () => {
      if (!html) return [];
      const out = [];
      for (const m of html.code.matchAll(/<button\b[^>]*>/g)) {
        const tag = m[0];
        const line = html.code.slice(0, m.index).split('\n').length;
        // A button is named if it has aria-label, aria-labelledby, or text
        // content. We can only see the tag here, so check the following chunk
        // for non-entity text before the closing tag.
        if (/aria-label(?:ledby)?\s*=/.test(tag)) continue;
        const after = html.code.slice(m.index + tag.length, m.index + tag.length + 400);
        const inner = after.slice(0, after.indexOf('</button>') + 1 || 400);
        const text = inner.replace(/<[^>]*>/g, '').replace(/&[a-z]+;|&#\d+;/gi, '').trim();
        if (text.length > 0) continue;
        if (exemptedFrom(html, line, 'no-title-only-labels')) continue;
        out.push({
          file: rel(html.path), line,
          detail: `<button> has no accessible name: ${tag.slice(0, 70)}`,
        });
      }
      return out;
    },
  },
];

/* ── Report ──────────────────────────────────────────────────────────────── */

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (code, s) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s);
const dim = (s) => c('2', s);
const bold = (s) => c('1', s);

console.log('');
console.log(bold('  SPNKr — design conformance'));
console.log(dim('  Rules are derived from ART-DIRECTION.md. If the spec changed, change the rule.'));
console.log('');

let failed = 0;
let warned = 0;

for (const rule of rules) {
  let findings = [];
  try {
    findings = rule.run().filter(Boolean);
  } catch (err) {
    console.log(`  ${c('33', 'ERROR')}  ${rule.id} — rule threw: ${err.message}`);
    warned++;
    continue;
  }

  if (findings.length === 0) {
    console.log(`  ${c('32', 'PASS ')}  ${rule.id}`);
    continue;
  }

  const isFail = rule.severity === 'fail';
  if (isFail) failed += findings.length; else warned += findings.length;

  console.log(`  ${isFail ? c('31', 'FAIL ') : c('33', 'WARN ')}  ${bold(rule.id)}`);
  console.log(dim(`         ${rule.spec}`));
  for (const f of findings) {
    const where = f.line ? `${f.file}:${f.line}` : f.file;
    console.log(`         ${c('36', where)}  ${f.detail}`);
  }
  console.log('');
}

if (exemptions.length) {
  console.log('');
  console.log(bold('  Declared exceptions'));
  for (const e of exemptions) {
    console.log(`  ${dim('·')} ${c('36', `${e.file}:${e.line}`)} ${e.rule} — ${e.reason}`);
  }
}

console.log('');
if (failed) {
  console.log(`  ${c('31', `${failed} violation${failed === 1 ? '' : 's'}`)}`
    + (warned ? dim(`, ${warned} warning${warned === 1 ? '' : 's'}`) : ''));
  console.log(dim('  Fix them, or add a design-check: allow comment with a stated reason.'));
  console.log('');
  process.exit(1);
}

console.log(`  ${c('32', 'Conformant.')}`
  + (warned ? dim(`  ${warned} warning${warned === 1 ? '' : 's'} to review.`) : ''));
console.log('');
