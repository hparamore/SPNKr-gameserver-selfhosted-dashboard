# Work Status

Running log. Newest entry first. Written so someone with zero context on the
session can pick the project up.

---

## 2026-08-03 (latest+5) — Data audit, optimize pass, shipped to GitHub

### Data-source audit — one real bug

**`queryUDPEndpoint` reported unknown player counts as zero.** `runPS` resolves
`null` when PowerShell errors; the function turned that into
`playerCount: 0`. Zero means *confirmed empty*, and `idleMonitor` shuts down
servers it believes are confirmed empty — so a transient PowerShell failure
could have shut down a server with people playing on it.

This is exactly the null-vs-zero invariant AGENTS.md warns about, violated in the
one place that isn't obvious. Fixed; unparseable output now returns `null` too.

### Gaps closed

- **No manual update check existed.** `checkForUpdate()` was exported and
  imported into api.js but never called from any route — a dead import. The only
  checks were scheduled at 3:30am/pm. Added `POST /servers/:id/check-update` and
  a Check Now button with a real busy state, since SteamCMD takes seconds.
- **Non-SteamCMD games had no update affordance.** Optional per-server
  `updateUrl` is now surfaced as a link from Configure. This replaces what used
  to be a *hardcoded Minecraft URL* in the old frontend.
- **Servers with no player query looked broken.** A game with no `queryProtocol`
  rendered the same em dash as a game whose query failed. The payload now carries
  whether a query is configured; the tooltip distinguishes not-configured,
  did-not-answer, and stopped.

### Optimize pass — nothing to do, and that's the finding

Measured rather than assumed:

- **500 full re-renders in 17.6ms** (0.035ms each). 500 renders is ~83 minutes of
  polling.
- **Zero DOM node growth** across those renders; heap flat at 2MB. No leak — this
  matters because the dashboard is left open for days.
- Zero cumulative layout shift.
- All six font weights are genuinely used on the page — no dead weight to drop.
- All in-memory collections bounded (cards, playerCache, transitioning, updating,
  event rows, toasts).

The reconcile-in-place architecture is doing its job. Premature optimization was
declined deliberately; there is no bottleneck to fix.

### Screenshots + tooling

`scripts/screenshots.mjs` — captures eleven states at 2x into `screenshots/`.
**Zero dependencies**, same constraint as design-check: Chrome is driven over the
DevTools Protocol using Node's built-in `WebSocket` (Node 22+), so no Puppeteer
or Playwright install on a host that has nothing but Node.

`screenshots/00-before-original-design.png` is the **pre-redesign UI**, captured
by extracting the original frontend from git at `28d1fb8`, serving it through the
demo harness, screenshotting, and restoring. Same six servers, same data, same
viewport — so the before/after difference is design and nothing else. Worth
keeping for the portfolio write-up.

**Gotcha:** the first run committed a Chrome profile. The script killed Chrome
then deleted the profile, but Chrome keeps writing for a moment after being
killed, so files reappeared inside `screenshots/` and got staged. The profile is
now created in the system temp dir via `mkdtempSync`, with a gitignore rule as
belt and braces. Verified by re-running.

### Shipped

Branch `redesign/spnkr`, eleven commits, pushed to origin.
**PR #1: https://github.com/hparamore/game-server-dashboard/pull/1**

README rewritten around what the product is, how to run it, and how to hand setup
to a coding agent — including *why* the prompts insist the agent surface elevated
commands rather than run them.

### Still true

**Nothing here has run against real NSSM services on Windows.** The new endpoints
are additive and mirror existing patterns, and their logic is exercised through
the demo against the real `database.js`, but `setServiceStartType` and the upload
filesystem path are untested on the target platform. That is the first thing to
check on the real box.

---

## 2026-08-03 (latest+4) — Ticker removed, motion retargeted, topbar quietened

### The ticker is gone

Hunter agreed with the concern raised when it was built: *"This is something
that is always up, and seeing movement is distracting."* Removed, along with its
JS (`measureTicker`, the resize listener) and the `no-loop-motion` exception it
needed.

**What was kept** — the parts that were working: overflowing state chips stay on
one line and are simply clipped under the Configure button, with the mask fading
the cut edge so truncation reads as "more" rather than broken. The chips aren't
important enough to justify motion; everything they say is also in the config
panel.

`ART-DIRECTION.md` now records this as **Rejected**, with the reasoning, so it
doesn't get reinvented — and explicitly says not to go back to wrapping either.

### Chip alignment bug — root cause

Chips sat 8px right of everything else on the card. Not padding: `.card-config`
and `.stat` both use the same 18px.

**The empty `.chip-fixed` element.** On a card with no action chips it's 0-wide
but still occupies a flex slot, so the parent's `gap: 8px` pushed the track
right. Fixed with `.chip-fixed:empty { display: none }`.

Measured after: tubes, `PLAYERS`, the connect value and the first chip all land
at exactly 20px.

### Motion, retargeted

Two carve-outs replace the one that was removed. Both are tied to something the
user must act on or wait for.

**Action-chip pulse.** Amber `Router Setup` / `Update Ready` chips breathe on a
2.6s cycle. Justified because an action chip is a *notification of unfinished
work*, not a state readout — it exists only while something needs doing and
vanishes when resolved, so it can't become permanent background motion. Pulse is
fill-and-border only, no size or position change. Hover stops it. State chips
never pulse.

**The working sweep.** A highlight travels around the border while a server is
starting, stopping, restarting or updating. Consistent with "nothing moves
unless something changed" — something *is* changing, and it stops the instant
the server settles.

Technique: two painted backgrounds — plate colour clipped to `padding-box`, a
conic gradient clipped to `border-box` so it shows only through the 2px border —
with `@property --shine-angle` making the angle animatable. **Graceful
degradation:** without `@property` support the gradient renders static amber,
which still reads as "working".

**Updates now hold the working state.** A SteamCMD update stops the service, so
the poll would have reported the card as plainly "stopped" mid-update. A new
`updating` Set, fed by `updateStatus` socket events, keeps the card working for
the whole operation. Verified both production `updater.js` and the demo emit
`serverId` on those events.

Scheduled restarts get the sweep for free — they pass through
`stopping`/`starting`, which already map to the working state.

### Topbar dividers removed

The 1px rules between brand / CPU / Memory / Disk / tool buttons. With a border
on every boundary the bar read as a stack of separate widgets and pulled focus
from the cards, which are the actual content. Spacing separates them now.

The `.stat` dividers *inside* cards were left alone — they separate columns in a
data row, which is different work.

### Verification

- Measured alignment: tubes / label / connect value / first chip all at 20px.
- **Motion audit of the resting DOM:** the only animating element is
  `chip alert -> chip-attention`. Nothing else moves at rest.
- Topbar elements with a left/right border: **0**.
- Working sweep: confirmed `shine-sweep` runs with a conic gradient during a
  start, and that both the animation and the gradient are gone once settled.
- `design-check`: conformant, 0 violations, 3 declared exceptions.

### Open questions / next steps

1. **Still uncommitted** — unchanged, and still the top risk.
2. If the action-chip pulse turns out to be too much in peripheral vision, the
   fallback is a static amber chip; the chip already reads as distinct without
   it.

---

## 2026-08-03 (latest+3) — Setup panel, port forwarding, chip ticker

### The correction that drove this

The previous entry added a `.status-note` to each card ("Won't auto-restart after
a crash", "Stays off until started"). Hunter rejected it, and was right:

> "that's not incredibly helpful to me... I want it to auto restart after a
> crash, so that's not helpful... most are unclear, and just add one more thing
> to try and read"

It also made card headers uneven, since only some cards had a note.

**The mistake was conflating state with settings.** Auto-recovery isn't a status
to read, it's a setting to control. Removed the note entirely and adopted a rule,
now in ART-DIRECTION.md:

> **The card shows state and things needing action. Configure owns settings.**
> A chip appears when you need to *do* something, not to inventory what's on.

Card headers are now a uniform 79px.

### Chips: two classes, one line

- **Action chips** (amber, `<button>`) — Router Setup, Update Ready. Pinned in a
  frozen left column, never scroll, and clicking one opens the config panel
  scrolled to the section that resolves it, tinted for ~1.8s.
- **State chips** (neutral) — Restart daily 4:00, Backups On, Idle 24h. Kept
  because Hunter explicitly wants them: "it helps me see into some of the system
  status."

Chips no longer wrap to a second line (that made cards uneven and shoved the
Configure button around). They ride a horizontal ticker instead.

**This is a deliberate exception to "no looping animation"** and is recorded as
such in both `ART-DIRECTION.md` and an inline `design-check: allow` with a
reason. Mitigations: it only runs when JS measures a *genuine* overflow, so most
cards never move; it dwells motionless ~40% of each cycle; hovering pauses it;
amber chips never scroll. **If it proves annoying in peripheral vision, drop to
hover-to-scroll — do not reinstate wrapping.**

### Port forwarding (new, spans server + frontend)

Router config happens outside this machine, so the dashboard can't detect or do
it. It can track whether the user has, and nag until then.

- **New setting** `portForwarded:<serverId>`, following the documented
  per-server settings pattern in AGENTS.md.
- **New endpoints** `GET`/`PUT /api/servers/:id/port-forward`.
- `portForwarded` added to the `pollAndEmit` payload; mirrored in the demo.
- **New config section** with the ports, this machine's LAN address, and generic
  router steps that work on any brand.
- Amber **Router Setup** chip until the user marks it done; then the ports vanish
  from the card but stay in the config panel permanently — Hunter needs them
  there to manage a limited number of router rules.

`GET /api/branding` now also returns `lanAddress` so the instructions can name
the actual internal IP rather than telling the user to go find it.

### Power section in the config panel

Run controls mirrored into the panel: live state, Start/Stop/Restart, and an
**Auto-recovery** toggle. It stays in sync with the poll while open, so its
buttons can't contradict the card behind it.

**Important:** the toggle hits a **new** `PUT /api/servers/:id/autostart`, not
the existing `POST /toggle`. `/toggle` sets the start type *and stops the
server* — fine for a kill switch, catastrophic as a settings switch. This
finally resolves the conflation flagged three entries ago. `/toggle` is left
untouched for compatibility.

Auto-recovery deliberately produces **no chip**: it's on by default and is a
setting, not a state.

### Setup panel (new)

New labelled **Setup** button in the topbar — the one control a first-time user
must be able to find, so it's a word, not a glyph.

Contains prerequisites with links, three copy-paste prompts for a coding agent
(install / add a server / troubleshoot), and a reference list. Each prompt bakes
in the constraint from AGENTS.md that **service registration and firewall rules
need elevation and the agent must surface commands rather than run them**, plus
the Unreal `*-Win64-Shipping-Cmd.exe` processName gotcha.

Headings are worded ("First — install and configure", "Then — add a game
server", "If something breaks") rather than numbered. Install→add is a genuine
dependency, but troubleshooting isn't "step 3", so numbering all three would
have been scaffolding-by-reflex.

### Also

- Card borders **1px → 2px**. At 1px the state hue was too faint to read across
  a room, which defeats the point of keying it.
- **Stopped tubes are now red outlines with hollow centres** rather than grey.
  Unfilled reads as "out".
- Header **tagline**: "Self-hosted game server control".

### Gotchas found

- **`requestAnimationFrame` never fires in a hidden/backgrounded tab.** The
  deep-link reveal silently did nothing. Switched to `setTimeout`. This is the
  second time rAF has bitten in this project — prefer timers for anything that
  must run regardless of visibility.
- **The `/impeccable` detector reported a false positive**,
  `numbered-section-markers "Sequence: 10, 11, 12"`. It matched the prose
  "Windows 10 or 11" and nearby `12 hours` option values, not section headings.
  Worth knowing before chasing it again.

### Verification

- `design-check`: **conformant**, 0 violations, 2 declared exceptions, 11 warnings.
- `/impeccable` detector: clean apart from the false positive above.
- Ticker: forced a 215px overflow — animation applies, config row stays 43px.
- Copy buttons: intercepted `clipboard.writeText`, confirmed exact prompt text.
  (Clipboard *read-back* is permission-blocked in-browser; the write path was
  verified instead.)
- All six card headers 79px; all six config rows 43px.

### Open questions / next steps

1. **Still uncommitted.** This now spans production `api.js` and `server.js`.
2. **The production port-forward and autostart endpoints have never run on
   Windows.** They're additive and follow the existing idle-shutdown pattern
   exactly, and the identical logic is exercised through the demo against the
   real `database.js` — but `setServiceStartType` in particular is untested here.
3. Stop reason still absent from the payload (see previous entry).

---

## 2026-08-03 (latest+2) — State provenance, side-stripe removal, /impeccable pass

### The question that started it

Hunter asked whether Start / Stop / Restart covers all the bases — specifically,
for a server with an idle timer, "would that be on? off? would it need restart?"

Traced it. `checkOne()` in `idleMonitor.js` only fires on a **running** server
confirmed empty, calls `stopService()`, and registers the stop as intentional so
the crash detector won't fight it. So an idle-shutdown server lands in exactly
the same `STOPPED` state as a hand-stopped one, and **START** brings it back, not
Restart.

**Conclusion: the three verbs are complete as actions. The status display was
the thing that was broken.** Two facts were being hidden:

1. **`autoStart` was in the poll payload and the frontend ignored it entirely.**
   When the auto-start toggle was removed in the redesign, the *information* went
   with it. A stopped server set to `auto` returns on reboot; one set to `manual`
   stays dead. Identical UI.
2. **`autoStart` also gates crash recovery.** `crashDetector.js:65` skips
   auto-restart for any server set to manual start. That hidden flag decides
   whether a crash self-heals and nothing said so.

### What shipped: `consequenceOf()`

Every card now carries a `.status-note` saying what happens next if nobody
intervenes. All five branches are live in the demo fleet:

| Server | State | Note |
|---|---|---|
| valheim | running + idle on | Shuts down after 24h with no players |
| palworld | running + manual | Won't auto-restart after a crash |
| minecraft | running + auto | *(nothing to say — the quiet happy path)* |
| satisfactory | stopped + auto | Starts again on reboot |
| vrising | stopped + manual | Stays off until started |

**Two design rules, both now in ART-DIRECTION.md:**

- It states only what is **certain** from the payload. It deliberately does not
  guess at *why* a server is down — the payload carries no stop reason, and
  "probably idled out" would be a lie on a crashed server.
- **Silence is a valid state.** A healthy auto-start server with no idle timer
  has nothing to say and says nothing. Not every card gets a badge.

No server-side change; `autoStart` and `idleShutdown` were already in the poll
payload. Demo `autoStart` values were varied across the fleet so all branches are
visible at once.

### Side-stripe borders removed (absolute ban)

The `/impeccable` detector independently flagged what its ruleset calls the
single most recognisable tell of generated UI: a thick coloured border on one
side. Both `.server-card` (3px left, state-keyed) and `.toast` (3px left) had it.

Rewritten to key the **full** border via `color-mix()`, which reads more strongly
at a glance anyway. The state signal was already tripled — border, surface value
(a stopped plate recedes to `--shell-750` with dimmed ink), and the tube readout
— so nothing was lost.

Added a **`no-side-stripe` rule to `design-check.js`** so it can't come back.

**Gotcha in writing that rule:** the first version matched `border-left: 1px` too
and reported `null` details for the topbar cells and stat columns, which use 1px
side borders as legitimate structure. The regex now matches 2px and up only
(`[2-9]|\d{2,}`). Verified: passes clean, fails on a reintroduced 3px stripe with
the exact line number, passes again on restore.

### Zero `:active` states

The stylesheet had **no `:active` rule anywhere** — every control in the product
felt dead on mousedown; the click registered but nothing acknowledged it until
the request returned. Added pressed states to `.btn`, `.tool-btn`,
`.modal-close`, and the reorder arrows.

### PRODUCT.md added

`/impeccable` treats a missing PRODUCT.md as a hard blocker. Written from the
existing repo docs rather than a fresh interview — register, users, personality,
anti-references and the accessibility bar were already committed across README,
ART-DIRECTION and AGENTS. Records the two-audience split (operator on a second
monitor; friends who just want a connect address) and five design principles.

### Verification

- `npm run design-check` — **conformant, 0 violations, 9 warnings** (unchanged
  pre-existing `state-hues-reserved` set), now across **16** rules.
- `/impeccable` detector on `public/` — **`[]`, clean** (was 2 side-tab hits).
- `.status-note` contrast measured at **5.25:1** against the plate, 13px.

### Known deviations from the /impeccable product register

Recorded deliberately rather than silently:

1. **CONFIGURE opens a modal.** The register says "modal as first thought is
   usually laziness — exhaust inline alternatives first." Kept, because an inline
   expander on a card inside an equal-height grid makes neighbouring cards jump
   on open. Revisit if the config panel grows.
2. **Two type families.** The register prefers one for product UI. The
   Barlow/Plex split is semantic (human text vs machine values) and standard in
   infrastructure tooling; keeping it.

### Open questions / next steps

1. **Still uncommitted.** Now the largest change set yet. This is the top risk.
2. **Stop reason is not in the payload** — the one thing the status note still
   can't say is *why* a server went down. Would need `pollAndEmit()` to carry a
   `lastStopReason` (crash / idle / user) and `lastPlayerSeen`, which would also
   allow an accurate "sleeps in 19h" countdown instead of a static "after 24h".
   Server-side change, deliberately not made unilaterally — needs a decision.
3. The 9 `state-hues-reserved` warnings are still unruled.

---

## 2026-08-03 (latest+1) — Review feedback: card heights, Discord icon, selects, type scale

Four pieces of feedback from Hunter, all applied.

**1. Cards in a row are now equal height, footers anchored to the bottom.**
Servers without a password rendered shorter and the rows read ragged. The grid
carried `align-items: start`, which opts every plate out of stretching. Removed
it (grid items stretch by default), made `.server-card` a column flex container,
and gave `.card-config` `margin-top: auto` so slack collects *above* the footer
rather than stretching it.

Verified at 1440px: row one is valheim/palworld/minecraft all 334px with footers
on the same pixel; row two all 310px, likewise.

**2. The settings icon is now the Discord mark.** It was a circle-with-rays
glyph that read as a light/dark toggle — reasonable, since that's what it looks
like, but it opens Discord webhook settings. Swapped for the Discord logo
(filled path, unlike the two stroked icons beside it — Discord's mark is
inherently a filled shape). `aria-label` updated from "Settings" to "Discord
notification settings". Rendered at 18/24/40/96px to confirm the path isn't
malformed at small sizes.

**3. Select chevrons no longer jam against the right edge.** The native control
draws its arrow hard against the border while the label has 12px of air on the
left, which reads as broken alignment. Now `appearance: none` with a hand-drawn
chevron at `right 12px center` and `padding-right: 36px` — optically symmetric
with the 12px left padding. Applies to every select in the product (config
panel, event-log filter) via `select.input`.

**Gotcha:** the chevron is an inline SVG data URI, which *cannot* inherit
`currentColor`. Its stroke is hardcoded `%239A9B8E` to match `--ink-dim`. **If
that token changes, change the data URI too** — there is a comment on the rule
saying so.

**4. The small-text tier was too small.** Barlow Condensed runs narrow and reads
about a size smaller than a normal sans at the same px, which the first pass
didn't account for. Raised across the board — micro-labels 10→12px, hints
12→14px, chips and small buttons 10→12px, form controls 13→14px, section titles
12→14px, plus the event-log row, badge, time, server and detail columns. The
event-log grid columns were widened to `92px 112px 124px 1fr` to hold the larger
badges.

Audited the rendered DOM for anything still under 12px; the only straggler was
the event-log disclosure chevron, also bumped.

`ART-DIRECTION.md` updated: the documented display-to-body ratio was 3:1
(30px → 10px) and is now 2.5:1 (30px → 12px), with an explicit "nothing renders
below 12px" rule and the reasoning about the condensed face.

### Verification

- `npm run design-check` — still **conformant, 0 violations, 9 warnings** (the
  same pre-existing `state-hues-reserved` set).
- No horizontal overflow at 1440px or 375px; topbar still folds to two rows on
  mobile and no system stat value wraps.

### Files touched

`public/css/styles.css`, `public/index.html`, `ART-DIRECTION.md`. No JS, no
server logic.

---

## 2026-08-03 (latest) — Mark corrected against reference; SPNKr spelling

### Two corrections from Hunter, both substantive

**1. The name is `SPNKr`, lowercase r.** That's the canonical Halo stylization
("SPNKr Prime", "SPNKr EX"). Everything shipped as `SPNKR`.

The non-obvious part: `.logo` carried `text-transform: uppercase`, which would
have silently forced the r back to a capital no matter what the markup said. The
property is now removed with a comment explaining why, and `ART-DIRECTION.md`
opens with the spelling rule so it doesn't drift back.

Changed in `index.html` (`<title>` + `<h1>`), `styles.css` (the transform + file
header), `app.js` header, `demo/server.js` (`/api/branding` + boot banner),
`ART-DIRECTION.md`, `scripts/design-check.js` banner. Note the production
wordmark comes from `config.json` → `dashboardName` via `/api/branding`, so
**the real deployment needs `dashboardName` set to `SPNKr`** — the markup value
is only a fallback.

Worth knowing: Hunter's own 3D reference has `SPNKR` stencilled on the barrel in
full caps, so both spellings exist in the wild. We standardised on the canon.

**2. The mark was built from the name, not the object.** Hunter supplied a
front-on render down the barrels. Two things were wrong:

- The bores are **offset diagonally**, upper-left to lower-right — not level and
  side by side. The old symmetric pair read as goggles.
- The housing is **rounded**, not a hard rectangle. The real weapon has a
  rounded shroud with the square receiver block behind it; a rounded square
  carries both in one shape.

Four candidates were rendered at 16/24/32/48/96px and judged at size, not in the
abstract. A capsule housing failed outright — it read as a map pin. A version
with the receiver block drawn in turned to mud below 32px. The diagonal
rounded-square won and is what shipped.

The asymmetry is the whole identity of the mark. Anything that levels the bores
or squares the housing has thrown it away.

### The knock-on nobody asked for, and the call made

`ART-DIRECTION.md` claimed "the brand mark **is** the instrument readout." Once
the mark went diagonal, the card readout (two level bars) no longer matched it.

Tested three options live: level bars, the literal mark silhouette stamped on
each card, and bars staggered diagonally.

**The literal mark was rejected.** Six copies of the logo down the page read as
*branding* rather than instrumentation, and repeating it made the header mark
feel less like an identity. Solid bars also stay legible from across the room —
the stated bar for this UI — where 5px bores close up.

**Shipped: staggered bars** (22px + 8px offset = the same 30px the header
allots). Keeps the diagonal signature, keeps the legibility, doesn't dilute the
logo. The spec's signature-move section now records the rejected option and why,
so it isn't re-litigated.

### design-check kept in sync

Per the standing rule that the spec and the checker move together: the
`tube-mark` rule quoted the old spec sentence verbatim, so it was rewritten.
It now also asserts the two traits that actually matter — the favicon still
shows two distinct bores, and `.tube:last-child` still carries the stagger.

Verified it isn't passing by accident: deleting the stagger rule from the CSS
makes `tube-mark` warn with "status bars are level — the diagonal stagger that
echoes the bores is missing", and restoring it returns to PASS.

**Still conformant: 0 violations, 9 warnings** (all pre-existing
`state-hues-reserved`, unchanged by this session).

### Gotcha worth remembering

The demo server serves `/api/branding` from its own source, and `applyBranding()`
overwrites the header text with it on load. After editing branding, **restart
`npm run demo`** — a browser reload alone will keep showing the old name and
looks like the edit didn't apply.

### Files touched

`public/favicon.svg`, `public/index.html`, `public/css/styles.css`,
`public/js/app.js` (header comment only), `demo/server.js`, `ART-DIRECTION.md`,
`scripts/design-check.js`.

No production server logic touched.

### Next steps

Unchanged from the entry below — the redesign is **still uncommitted**, and that
remains the biggest risk on the project. Add to the list: set `dashboardName` to
`SPNKr` in the real `config.json` on the Windows host.

---

## 2026-08-03 (later) — Art direction made enforceable

### Context

The redesign from the previous entry is **done and verified running** — loaded
the demo harness at `localhost:8080` and read the real UI rather than the CSS.
Running and stopped servers are distinguishable at a glance without reading a
word, which was the spec's stated bar.

`ART-DIRECTION.md` ended with an anti-default checklist a human was supposed to
tick off before calling any UI done. Humans don't. Six months from now a 16px
radius comes back through one component and nothing in the repo can tell a
deliberate exception from a regression. This session made the checklist
executable.

### What was added

**`scripts/design-check.js`** — zero-dependency conformance checker.

```bash
npm run design-check
```

Fifteen rules, each citing the section of `ART-DIRECTION.md` it enforces, so a
failure sends you to the spec rather than to a lint config:

| Rule | Enforces | Severity |
|---|---|---|
| `no-shadow` | Finish — zero `box-shadow` | fail |
| `radius-2px` | Finish — 2px corner cap | fail |
| `no-loop-motion` | Motion — no infinite/repeating animation | fail |
| `no-card-transform` | Motion — no `hover:scale`/transform on cards | fail |
| `no-glass` | Finish — no backdrop blur / glassmorphism | fail |
| `three-hues` | Color — indigo/purple/blue stay deleted | fail |
| `contrast-aa` | Color — every ink clears WCAG AA 4.5:1 | fail |
| `semantic-type` | Type — no default system sans stack | fail |
| `self-hosted-fonts` | Type — no font CDN (must work on an offline LAN) | fail |
| `no-title-only-labels` | A11y — every icon-only button has a name | fail |
| `tokens-only` | Color — no raw hex outside `:root` | warn |
| `reduced-motion` | Motion — `prefers-reduced-motion` guard present | warn |
| `tube-mark` | Signature move — mark still doubles as status readout | warn |
| `state-hues-reserved` | Color — `--ok`/`--fault` only for run state | warn |
| `label-tracking` | Type — uppercase micro-labels carry tracking | warn |

**Current result: conformant.** 0 violations, 9 warnings (all from
`state-hues-reserved` — see next steps).

Verified end to end on a scratch copy: an injected `box-shadow` and a 16px
radius both fail and exit 1; an exempted line passes and is reported under
"Declared exceptions".

### Decisions made, and why

**Exceptions are declared inline, not configured.** A line opts out with
`/* design-check: allow <rule-id> — <reason> */`. The reason is mandatory, and
every exception is reprinted on every run. A config file would let exceptions
accumulate silently somewhere nobody reads; this keeps them attached to the code
they excuse and visible in the output.

**Zero dependencies.** This has to run on the Windows host, where nothing is
installed but Node. No PostCSS, no Stylelint.

**Contrast is measured only against surfaces an ink can actually land on** — the
four inherited surfaces (`--shell-900/800/750/700`) plus any surface explicitly
paired with that ink in the same rule block. `--shell-600` is excluded on
purpose: the token table calls it "Raised / hover", it only ever appears as a
hover background, and those same rules promote text to `--ink`. Grading every
ink against it flagged `--ink-mute` at 4.31:1 for a pairing that never renders.

**Worth knowing, and worth fixing in the spec:** for light ink on dark shells
the worst case is the *lightest* surface, not the darkest. The `--ink-mute`
comment in `styles.css` and the Color section of `ART-DIRECTION.md` both say to
measure "on the darkest surface it can appear on" — the reasoning is inverted,
though the values that shipped are fine. The rule takes the minimum ratio across
candidates rather than assuming which end of the scale is hardest.

### Connections

- `scripts/design-check.js` reads `public/css/styles.css`, `public/index.html`,
  `public/js/app.js`, `public/favicon.svg`. Read-only — it changes nothing.
- `package.json` — added `design-check` alongside `start` and `demo`.
- `ART-DIRECTION.md` — the checklist section now says which items are automated
  and documents the exception syntax.
- No production code touched. `server.js`, `src/`, and `demo/` are untouched.

### Rule change for future work

**The spec and the checker move together.** If a rule in `design-check.js` is
wrong, change the rule *and* the corresponding section of `ART-DIRECTION.md` in
the same commit. A rule that contradicts the spec is worse than no rule, because
it trains you to ignore the output.

### Open questions / next steps

1. **The redesign is still uncommitted** — modified `styles.css`, `index.html`,
   `app.js`, `AGENTS.md`, `.gitignore`, `package.json`, plus untracked
   `ART-DIRECTION.md`, `demo/`, `public/fonts/`, `public/favicon.svg`,
   `src/db/`. Biggest risk on the project right now.

2. **Rule on the 9 `state-hues-reserved` warnings.** Each is a real decision
   about whether `--ok`/`--fault` are earning their keep:
   - `.sys-bar-fill.danger` (styles.css:211) — a red CPU/RAM bar. Not run state.
     Strongest candidate for a genuine violation; `--amber` is the likely fix.
   - `.toggle input:checked` (708, 710) — a settings toggle, not run state.
   - `.link-banner` (512), `.modal-close:hover` (775), `.toast.success` (893) —
     chrome, not state.
   - `.stat-value.has-players` (383) — green player count. Arguably state.
   - `.event-type.good` / `.bad` (609, 612) — the event log *is* a run-state
     log; probably legitimate.

   Whichever way each goes, encode it: retint, or add a
   `design-check: allow state-hues-reserved — <reason>` on the line.

3. **README screenshot.** Commit `28d1fb8` dropped a missing screenshot
   reference. `npm run demo` now renders the finished UI on macOS, so a real
   screenshot can be captured and the reference restored.

4. **Wire the check into a pre-commit hook or CI** once the redesign is
   committed, so it runs without being remembered.

### Gotcha

`npm run demo` binds port 8080 and an instance may already be running from an
earlier session — a second `npm run demo` dies with `EADDRINUSE`. Check with
`curl -s -o /dev/null -w "%{http_code}" http://localhost:8080` before assuming
it failed to start.

---

## 2026-08-03 — Repo repair, art direction, UI/UX pass

### The headline: the repo could not start

`src/db/database.js` was missing from version control. Ten modules import it
(`server.js`, `src/routes/api.js`, and six services), so `npm start` died
immediately on `ERR_MODULE_NOT_FOUND`.

**Cause:** `.gitignore` line 6 was `db/`. Git patterns without a leading slash
match at *any* depth, so a rule meant to exclude the SQLite data directory at the
project root also excluded `src/db/` — which is source code. Confirmed with
`git check-ignore -v src/db/database.js`.

**Fix:** changed the rule to `/db/` and reconstructed `database.js` from the
schema documented in AGENTS.md plus every one of its ~60 call sites.

Reconstruction notes, because these matter if the original ever resurfaces:

- `getOldestBackups()` orders **DESC** with `LIMIT -1 OFFSET keepCount`. AGENTS.md
  flags that ASC "shipped once and quietly destroyed every new backup for weeks."
  Verified: with 6 backups and retention 3, it returns backups 1–3 (the oldest).
- `backups.timestamp` is written as a full ISO-8601 string with an explicit `Z`,
  **not** SQLite's `CURRENT_TIMESTAMP`. The frontend parses that field with a bare
  `new Date(...)`, which reads `"YYYY-MM-DD HH:MM:SS"` as *local* time and would
  shift every backup by the UTC offset. `events.timestamp` keeps
  `CURRENT_TIMESTAMP` because the frontend explicitly appends `Z` for that one.
- `setSchedule(serverId, cronExpression, warningSent, enabled)` — the third
  argument is only ever passed `false` by `scheduler.js` and never read back
  anywhere, so its exact original meaning is a guess. Stored as
  `warning_sent INTEGER DEFAULT 0`.
- WAL journal mode is on, so a backup insert can't block a status read and stall
  the 10s poll.

All 14 modules now resolve and every function was smoke-tested.

### Demo harness (new)

`demo/server.js`, run with `npm run demo`. The production app is Windows-only
(NSSM + PowerShell + `Get-CimInstance`), so the UI could not be seen or worked on
from a Mac at all.

It fakes **only** the platform layer. Event log, settings, schedules and backup
configs all go through the real `src/db/database.js`, so those paths get genuinely
exercised. The synthetic fleet covers every card state on purpose: running with
players, running but empty, stopped, update-available, a server whose player query
returns `null` (must render `—/N`, never `0/N`), and a password containing an
apostrophe.

**Gotcha:** its Socket.IO payloads mirror `pollAndEmit()` in `server.js`. Change
that payload and the demo drifts unless you change it too.

### Art direction (new) — `ART-DIRECTION.md`

There was no design identity anywhere in the repo, so the visual work had no
target. Established one and wrote it down as a binding spec.

**Three words: ISSUED · LEGIBLE · UNFUSSY.** SPNKR is the M41 rocket launcher —
two tubes and a handle, equipment rather than decoration.

The decision that drove the most change: **primary context is a second monitor.**
It's seen in peripheral vision more than looked at. That single constraint killed
both of the old build's infinite `pulse` animations and set the rule that nothing
moves unless something actually changed.

Locked decisions: structural layout with 1px rules instead of shadows; Barlow
Condensed for human text against IBM Plex Mono for every machine value (the split
is semantic, not decorative); gunmetal shell with amber as the system colour;
2px corners; and the two-tube mark reused as the per-card status readout.

### What changed in the UI

Full rewrite of `styles.css`, `index.html`, `app.js`. Behaviour and API contract
unchanged except where noted below.

**Bug — quote escaping (proven in-browser, then fixed).** `esc()` escaped `&<>`
but left `'` and `"` untouched, and its output was injected into both HTML
attribute *and* JS string contexts. The demo's Enshrouded password `flame's edge`
generated `copyText('flame's edge', this)` — a `SyntaxError` that threw on every
click. Fixed at the root: nothing interpolates user data into markup any more.
Values go in via `textContent`/`dataset`, handlers via delegation. `esc()` is
gone; don't add it back. Re-verified with hostile input (`<script>`, quotes,
`");alert()//`) — renders as literal text, zero injected nodes.

**Bug — grid teardown.** `renderServerCards()` reassigned `grid.innerHTML` on
every status poll (10s) *and* every player poll (30s), destroying hover, focus,
text selection and scroll position four times a minute. Now reconciles against a
`Map` and mutates in place. Verified node identity and focus survive repeated
renders.

**Bug — dead selectors.** `setTransitioning()` queried `.status-badge` and
`.action-btn`, neither of which existed in the card markup any more (the badge
had been replaced by `.status-text`). The working state was partly non-functional.
Roughly 200 lines of orphaned CSS removed with it.

**Bug — stuck "Working" state.** Introduced and then fixed during this session:
the clear condition was inverted, so a card sat in its working state for a fixed
6s timeout instead of settling when the service reported done. `transitioning` is
now a `Map` of id → status-at-action-time, and clears as soon as the reported
status is both settled *and different*. Measured: settles at ~2.4s.

**UX — Stop button added.** Cards previously offered only Start or Restart. The
sole way to stop a server was the auto-start toggle, whose tooltip said "starts on
boot" — one control silently meaning two things. `POST /api/servers/:id/stop`
already existed and was simply unused by the frontend.

**UX — four config rows collapsed into one panel.** Version, restart schedule,
backups and idle shutdown were four near-identical rows with four separate Edit
buttons opening four modals, eating about half of each card's height for data you
set once and never read. They're now summary chips plus one `CONFIGURE` control
opening one consolidated panel. Cards are roughly half as tall.

**UX — states that didn't exist.** An empty `servers` array (which is what a fresh
install has) showed "Connecting to dashboard…" forever; there's now a real empty
state. A dropped Socket.IO connection only logged to the console and left stale
numbers on screen indefinitely; there's now a link-lost banner that dims the grid.

**UX — `window.confirm()` replaced** with an in-design dialog, and confirmation
added to Stop and Restart (both disconnect players).

**Accessibility.** Focus trap, Escape-to-close, and focus restoration on all
modals; `role="dialog"` / `aria-modal`; `aria-label` on every icon button;
`aria-pressed` on the privacy toggle; `aria-expanded` on the event log;
`aria-live` on toasts; visible focus rings throughout. Contrast measured rather
than eyeballed — `--ink-mute` was failing AA at 4.04:1 on the recessed surface
while labelling every field on the card, so it moved from `#7A7B6F` to `#8A8B7D`
(5.02:1 worst case). All other pairs pass.

**Fonts.** `'Consolas', 'Monaco', monospace` was broken on both platforms —
Consolas doesn't exist on macOS, Monaco doesn't exist on Windows, so each fell
through to the generic. Replaced with self-hosted woff2 (88KB, latin subset, both
OFL), which also means no CDN request on a LAN with no internet.

### Files touched

| File | What |
|---|---|
| `src/db/database.js` | **New** — reconstructed |
| `.gitignore` | `db/` → `/db/` (the bug above) |
| `demo/server.js` | **New** — cross-platform harness |
| `package.json` | Added `npm run demo` |
| `ART-DIRECTION.md` | **New** — binding visual spec |
| `WORK_STATUS.md` | **New** — this file |
| `public/index.html` | Rewritten |
| `public/css/styles.css` | Rewritten |
| `public/js/app.js` | Rewritten |
| `public/favicon.svg` | **New** — the two-tube mark |
| `public/fonts/*.woff2` | **New** — 6 files |
| `AGENTS.md` | Frontend invariants, demo harness, gitignore warning |
| `README.md` | Demo mode section, doc table |

No server-side logic changed. `src/routes/api.js` and every service are untouched.

### Open questions / next steps

1. **`POST /api/servers/:id/toggle` still conflates two actions.** Passing
   `enabled: false` sets the service to manual start *and* stops the server. Now
   that a real Stop button exists, those should split — but that's a server-side
   behaviour change affecting the Discord bot too, so it was left alone. The
   auto-start control is currently omitted from the card; decide whether it
   belongs in the config panel with honest labelling, or whether the endpoint
   should be split first.
2. **The event log only streams live for crashes.** `logEvent()` writes to SQLite
   but doesn't emit; only `server.js` emits `eventLogged`, and only for crash
   events. Everything else needs a manual Refresh. The demo harness already does
   it properly — worth lifting that pattern into production.
3. **`npm audit` reports 13 vulnerabilities (1 critical).** Not investigated.
4. **`database.js` is a reconstruction.** If the original turns up on the Windows
   machine, diff it — particularly the `schedules.warning_sent` column.
5. **Nothing is committed.** All changes are in the working tree.
6. Verified only in Chromium via the demo harness. Not yet run against real NSSM
   services on the Windows box.
