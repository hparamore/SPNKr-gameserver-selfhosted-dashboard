# Art Direction — SPNKr

> **Spelling: `SPNKr`, lowercase r.** This is the canonical Halo stylization
> (cf. "SPNKr Prime", "SPNKr EX"). It is never `SPNKR` or `Spnkr` in product
> text, and `.logo` therefore carries **no** `text-transform` — uppercasing the
> wordmark would silently destroy the one detail that makes it correct.

> The visual execution layer. Every build decision obeys this spec. When in
> doubt, diverge from the default.
>
> **Three words: ISSUED · LEGIBLE · UNFUSSY.**
>
> SPNKr is named for the M41 rocket launcher — two tubes and a handle. Stubby,
> mechanical, unglamorous. It is *equipment*, not decoration. This dashboard is
> a piece of issued kit that happens to run in a browser.
>
> **Primary context: left open on a second monitor.** It is seen more often in
> peripheral vision than looked at directly. It must be calm at rest and
> readable from across the room. Anything that moves when nothing has changed
> is a bug.

## Compositional move

**Structural, not decorative.** Hard divisions, 1px rules doing the work of
shadows, dense but hierarchical. The plate metaphor: each server card is a
labelled equipment panel, not a floating rounded rectangle.

**Hierarchy is by state, not by uniformity.** The old card gave eleven data
points identical visual weight. The new one has three tiers:

1. **Glance tier** — server name, run state, players online. Readable at 3
   metres. Dominates the card.
2. **Live tier** — RAM, uptime, connect address. Machine values in mono,
   secondary weight.
3. **Config tier** — version, restart schedule, backups, idle shutdown. These
   are set once and never read. They collapse behind a single `CONFIGURE`
   control that opens **one** consolidated panel.

A running card and a stopped card must be distinguishable without reading a
single word.

**A status must imply its consequence.** "Stopped" is half an answer — it
doesn't say whether the server comes back on its own, and it looks identical
whether a person stopped it or the idle monitor did. Every card carries a
`.status-note` stating what happens next if nobody intervenes ("Stays off until
started", "Shuts down after 24h with no players"). Two rules govern it:

- It states only what is **certain** from the payload. It never guesses at *why*
  a server is currently down; "probably idled out" is a lie on a crashed server.
- Silence is a valid state. A healthy server on auto-start with no idle timer
  has nothing to say, and says nothing.

**Forbidden:** uniform card grids where every card looks identical regardless
of state; equal padding on all sides; centering things that could be aligned to
a rule; giving config data the same weight as live data.

## Type

- **Display: Barlow Condensed** (600/700) — server names, section headers,
  buttons. Uppercase with tracking for anything acting as a label. Reads as
  stencilled equipment marking and packs tightly at large sizes.
- **Body: Barlow Condensed** (400/500) for human-language text; **IBM Plex
  Mono** (400/500) for *every machine value* — addresses, ports, RAM, uptime,
  build numbers, cron strings, byte sizes.
- Both self-hosted as woff2 (no build step, no external CDN request, works on a
  LAN with no internet).

The mono/condensed split is **semantic, not decorative**: if a human wrote it,
it's Barlow; if a machine emitted it, it's Plex Mono. Never mix within a value.

- **Display-to-body ratio: 2.5:1** (30px server name → 12px micro-label). This
  is deliberate restraint, not timidity — an 8:1 ratio wastes the vertical space
  that density buys us on a glanceable panel. The drama comes from *weight and
  tracking contrast*, not size alone.
- **Nothing renders below 12px.** Barlow Condensed is a condensed face and reads
  roughly a size smaller than a normal sans at the same pixel value, so the
  small-text tier sits higher here than it would elsewhere: 12px micro-labels,
  12px chips and small buttons, 14px hints and form controls. The first pass
  used 10px labels and 12px hints and was genuinely hard to read.
- **Signature type moment:** the connect address is set in Plex Mono at a size
  that competes with the server name rather than hiding beneath it. The thing
  you came to copy is the second-loudest element on the card. Micro-labels get
  `0.18em` tracking — stencil spacing.

## Color

Gunmetal shell, amber system color. **Three semantic hues, down from five** —
the old palette used indigo, green, red, yellow, blue *and* purple.

| Token | Value | Role |
|---|---|---|
| `--shell-900` | `#0C0D0B` | Page ground. Warm near-black, never blue-black. |
| `--shell-800` | `#151613` | Card plate |
| `--shell-700` | `#1D1F1A` | Recessed rows, inputs |
| `--shell-600` | `#262820` | Raised / hover |
| `--rule` | `#32352C` | 1px hairline — the primary structural device |
| `--rule-bright` | `#4A4E42` | Emphasised division |
| `--ink` | `#E8E6DE` | Primary text. Warm off-white, never `#fff`. |
| `--ink-dim` | `#9A9B8E` | Secondary text |
| `--ink-mute` | `#8A8B7D` | Tertiary — field labels. Measured AA on every surface. |
| `--amber` | `#FFB020` | System colour: brand, focus, active config, attention |
| `--ok` | `#6FD24A` | Running / healthy — this hue means one thing only |
| `--fault` | `#FF5540` | Stopped / crashed / failed |

**Deployment: large fields, not dabs.** Status is a filled bar and a colour-keyed
edge on the plate, not a 8px dot. Amber is the only accent that appears in
chrome; `--ok` and `--fault` are reserved exclusively for run state and never
used decoratively.

This extends to the run controls: Start and Stop sit **neutral at rest** and
take their colour only on hover/focus. Six red STOP buttons glowing across the
grid is noise on a screen that lives in peripheral vision, and it would spend
`--fault` on something that isn't a fault.

Every foreground/background pair in this table has been measured against WCAG
AA (4.5:1) on the **darkest surface it can appear on**. Re-measure before
changing any ink value.

Indigo `#6c63ff`, `--purple`, and `--blue` are **deleted**, not re-tinted.

## Finish

- **Depth: borders only.** Zero `box-shadow` in the entire stylesheet. Elevation
  is communicated by rule weight and surface value.
- **No side stripes.** A coloured border on one side, thicker than the 1px
  hairline, is banned outright — it is the single most recognisable tell of
  generated UI. Cards and toasts both shipped with a 3px left stripe and both
  were rewritten to key the *full* border, which reads more strongly anyway.
  1px `border-left`/`border-right` as structure (topbar cells, stat columns) is
  fine and expected; enforced by the `no-side-stripe` rule.
- **Corners: 2px.** Near-square throughout. The old 16px radius is the single
  biggest "soft SaaS" tell in the current design. The only curved geometry in
  the product is the tube mark, which earns it by being a circle.
- **Texture:** a fixed 2px diagonal hatch on the page ground at ~2.5% opacity,
  via `repeating-linear-gradient` — no image, no cost. It should be felt, not
  seen. Card plates stay flat.
- No glassmorphism, no backdrop blur, no gradient fills on surfaces.

## Motion

**This is the lever the second-monitor context governs.**

- **Forbidden outright:** infinite/looping animations of any kind (the current
  `pulse` on `.status-dot` and `badgePulse` on `.update-badge` both violate
  this and are removed); `hover:scale` or any transform on cards; uniform
  fade-ins on load; smooth easing on state changes.
- **Signature interaction — the relay flash.** When a server changes run state,
  its status field snaps through a single hard flash using
  `steps(2, end)` over `240ms`, then holds. Mechanical, like a relay throwing —
  not a soft cross-fade. It is the *only* thing on the page that moves, and it
  only moves when something genuinely changed.
- Hover: `border-color` transition only, `100ms linear`. No movement.
- All motion inside `@media (prefers-reduced-motion: no-preference)`.

### The two carve-outs

Both are looping animations. Each earns it by being tied to something the user
needs to act on or wait for — neither is ambient decoration, and neither runs on
a dashboard that is simply sitting there healthy.

**1. Action-chip attention pulse.** Amber `Router Setup` / `Update Ready` chips
breathe on a 2.6s cycle. An action chip is a *notification of unfinished work*,
not a state readout: it exists only while something needs doing and disappears
the moment it's resolved, so it can never become permanent background motion.
The pulse is fill-and-border only — no size or position change — so it registers
peripherally without dragging the eye. Hover stops it.

State chips (`Backups On`, `Idle 24h`) never pulse. Neither does anything that
is merely a check rather than a notification.

**2. The working sweep.** While a server is starting, stopping, restarting
(including scheduled restarts) or updating, a highlight travels around its
border. This does not contradict "nothing moves unless something changed" —
something *is* changing, and the motion ends the instant the server settles into
running or stopped.

Built as two painted backgrounds: the plate colour clipped to `padding-box`, and
a conic gradient clipped to `border-box` so it shows only through the 2px
border. `@property --shine-angle` makes the angle animatable. Where `@property`
is unsupported the gradient renders static amber, which still reads correctly as
"working".

### Rejected: the chip ticker

An earlier build scrolled overflowing state chips back and forth on a marquee.
It was removed. On a screen that lives in peripheral vision, motion at rest is a
defect no matter how well-mannered — and the chips aren't important enough to
justify it, since everything they say is also in the config panel.

**Overflowing state chips are simply clipped**, with a mask fading the cut edge
so a truncated chip reads as "more" rather than as broken. Do not reintroduce
motion here, and do not go back to wrapping onto a second line (that made cards
uneven and shoved the Configure button around).

## Signature move

**The two-tube mark, used as both logo and instrument.**

The M41 viewed down the barrels. Three things are drawn from the real weapon
and none of them are negotiable, because they're what stop it reading as a
generic pair of circles:

1. **The bores are offset diagonally**, upper-left to lower-right — not level
   and side by side. This asymmetry is the whole identity of the mark; a
   symmetric pair reads as goggles.
2. **The housing is a rounded square**, not a hard rectangle — the real launcher
   has a rounded shroud around both barrels with the square receiver block
   behind it. The rounded square splits that difference in one shape.
3. **The bores are knocked out of a solid housing** (`fill-rule="evenodd"`),
   not drawn as outlined rings. A positive shape survives 16px; 2px-stroke
   rings collapse into "oo".

This is the **one exception to the 2px corner rule** — the mark is allowed its
curves because it is depicting a physical object with them.

The move is that **the mark's geometry recurs as the status indicator on every
card** — two bars, staggered diagonally to echo the offset of the bores:

- both filled `--ok` → running
- both dark → stopped
- one filled `--amber` → transitioning

Learn the mark and you can read every server's state from across the room
without reading a word.

**Why an echo rather than a copy.** Rendering the actual mark silhouette on each
card was tried and rejected: six copies of the logo down the page read as
branding rather than instrumentation, and repetition made the header mark feel
less like an identity. The readout takes the mark's *one* signature trait — the
diagonal — and nothing else. Solid bars also hold at a glance where 5px bores
would close up.

## Header images

Optional 160px banner across the top of a card. Governed by one global view
option; per-server choice lives in that server's Configure panel.

- **Four bundled banners** ship in `public/img/headers` (forest, ruins, desert,
  ice), each as webp with a jpg twin. The frontend requests webp and falls back
  to jpg on error.
- **Resolution order: custom upload → chosen preset → global default.** Turning
  images off never discards either stored value, so turning them back on
  restores exactly what was there.
- **A bottom scrim** (48px, to `rgba(12,13,11,.72)`) keeps the plate reading as
  one object rather than a photo with a card stuck underneath.
- **Card content stays anchored to the top.** When one card in a row has a
  banner the others stretch to match; centring their content in the leftover
  space was tried and rejected — rows stopped lining up across the grid and it
  read as unstructured. Empty space above the config bar is the orderly result.

## Anti-default checklist

Most of this list is enforced by `npm run design-check`, which reads the CSS and
markup and fails on anything that violates the sections above. Run it before
calling any UI done — it catches the drift you stop noticing after a week of
looking at the same screen.

A deliberate exception is declared inline, with a reason, on the offending line:

```css
.toast { box-shadow: 0 1px 0 var(--rule); } /* design-check: allow no-shadow — hairline, not elevation */
```

Exceptions are printed in the report every run, so they stay visible instead of
quietly becoming the new default. If a rule is wrong, change the rule *and* this
spec in the same commit — they are meant to move together.

The remaining items are judgement calls a script can't make. Confirm NONE of
these crept back in:

- [ ] Centered hero → subhead → CTA stack
- [ ] Card grid where every card looks identical regardless of state
- [ ] Soft drop shadows / glassmorphism / backdrop blur
- [ ] Single accent color on neutral grays
- [ ] Default system/Inter sans at timid sizes
- [ ] Uniform `hover:scale` on cards
- [ ] Relentless symmetry / equal padding everywhere
- [ ] Any looping animation (violates the second-monitor context)
- [ ] Radius above 2px on anything that isn't the tube mark
- [ ] More than three semantic hues
- [ ] `--ok` or `--fault` used for anything other than run state
- [ ] A machine value set in the display face, or prose set in mono
