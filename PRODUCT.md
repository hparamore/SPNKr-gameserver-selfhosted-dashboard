# Product

> Strategic context: who this is for and why it exists. Visual execution lives in
> [ART-DIRECTION.md](ART-DIRECTION.md); architecture in [AGENTS.md](AGENTS.md).
>
> Derived from the existing repo docs (README, ART-DIRECTION, AGENTS) rather than
> a fresh interview — the personality, anti-references and accessibility bar were
> already committed there.

## Register

product

## Users

**Primary: one operator (the owner).** Runs a Windows box at home hosting a
handful of dedicated game servers. Design-literate, comfortable in a filesystem,
growing terminal fluency. The dashboard is **left open on a second monitor** and
is seen in peripheral vision far more often than it is read.

**Secondary: a handful of friends**, on the LAN or over Tailscale. They open it
to grab a connect address or start a server nobody's running. They have no
context on NSSM, services, or cron, and should never need any.

**The job:** answer *"is it up, can I join, and who's on"* in under two seconds,
and failing that, start the thing — without reading documentation or logging into
a Windows box.

Everything else the product does (restart schedules, backups, idle shutdown,
SteamCMD updates) is configured once and then wants to be invisible.

## Product Purpose

Replace paying a game-hosting company, and replace RDP-ing into a home server
every time someone wants to play something. It manages real Windows services
through NSSM, so a mistake here stops a server people are actually playing on.

Success: the operator stops thinking about it. The servers are up, the friends
self-serve, and the dashboard only demands attention when something is wrong.

## Brand Personality

**ISSUED · LEGIBLE · UNFUSSY.**

Named for the M41 SPNKr — two tubes and a handle. Stubby, mechanical,
unglamorous. This is *equipment*, not a product tour. It should feel like a
panel that was installed, not an app that was launched.

Voice: terse and literal. Say what happened and what will happen next. No
exclamation marks, no encouragement, no "Oops!". A stopped server is a fact, not
a problem to soften.

## Anti-references

- **Generic dark-mode SaaS.** Indigo-on-charcoal, 16px radii, soft shadows,
  glassmorphism. This is precisely what the first version of this dashboard was,
  and the redesign exists to leave it.
- **Game-hosting company control panels** (GPortal, Nitrado): ad-dense,
  upsell-driven, cluttered with things you can't turn off.
- **Anything that pulses, breathes, or animates at rest.** The second-monitor
  context makes idle motion a defect, not delight.
- **Consumer-app cheerfulness.** No mascots, no celebration states, no "You're
  all set! 🎉".

## Design Principles

1. **State before chrome.** The three questions — up? joinable? who's on? —
   outrank every other pixel. Config that's set once and never read gets
   collapsed, not featured.
2. **Say what happens next.** A status is incomplete if it doesn't imply the
   consequence. "Stopped" is half an answer; "stopped, and it won't come back on
   its own" is the whole one.
3. **Nothing moves unless something changed.** Motion is a signal, and a signal
   that fires constantly is noise.
4. **Machine values look like machine values.** If a computer emitted it, it's
   monospace and copyable. If a human wrote it, it isn't.
5. **Destructive actions are boring at rest.** Stop and Restart disconnect real
   people mid-game. They confirm, and they don't shout for attention while idle.

## Accessibility & Inclusion

- **WCAG 2.1 AA is the floor and is enforced, not aspirational.** Every ink/surface
  pair is measured by `npm run design-check`, which fails the build on a miss.
- Colour is never the sole carrier of state — run state is also conveyed by text
  and by the position of the tube readout.
- `prefers-reduced-motion` fully honoured; the only motion in the product is a
  240ms state-change flash.
- Full keyboard operation: visible focus rings, focus trapped in dialogs, Escape
  to close, focus restored to the trigger.
- Readable at ~3 metres from a second monitor — this drives the type scale as
  much as accessibility does. Nothing renders below 12px.
