# SPNKr — case study

Self-hosted game server control. A tool I built to stop paying a hosting
company, and then redesigned to stop looking like everything else.

---

## Why it exists

I was renting two dedicated game servers, about **$30 a month**, and that money
bought exactly two games. Wanting to play a third meant paying for a third, or
tearing one down and losing the world.

The hardware sitting in the next room was doing nothing.

SPNKr moves the whole arrangement onto a spare computer. **No monthly fee**, and
**up to six games** running at once instead of two. Everything the hosting panel
did — start, stop, restart, scheduled restarts, automatic backups, update
checks — happens locally, plus things the rented panels never offered: my friends
can bring a server up themselves from Discord, without me, without a login, and
without knowing anything about Windows services.

The honest version of the savings: **~$360/year in hosting fees**, against the
electricity of a machine that was already there. That's the trade, and it's a
good one.

The unlock wasn't really the money. It was that **the marginal cost of a seventh
game went to zero.** When adding a server costs nothing, you add servers. We now
run games nobody would have paid $15/month to try.

---

## What it does

- One plate per server: run state, players online, memory, uptime, connect
  address and password, with copy buttons for the two things people actually ask
  me for.
- Start / stop / restart from the browser or from Discord slash commands.
- Scheduled restarts with countdown warnings posted to Discord.
- Automatic backups on a cron schedule, with retention limits.
- Crash detection with rate-limited auto-restart.
- SteamCMD update detection — twice daily, on demand, installable in one click.
- **Auto-off when empty**: a server shuts itself down after N hours with nobody
  on it, so it isn't burning RAM all week. Anyone can wake it with `/start` in
  Discord. This is the feature that makes six games on one box practical.
- Player counts per game via each game's native query protocol.

---

## The design pass

I'm working back through things I'd already built and taking them out of default
AI output — the look you get when nothing was decided, only generated.

**Before and after**, same six servers, same data, same viewport:

| | Before | After |
|---|---|---|
| Palette | Indigo `#6c63ff` on blue-black, five semantic hues | Gunmetal and amber, three semantic hues |
| Card | Four stacked config rows, four separate modals | One Configure panel, roughly half the height |
| Stopping a server | No stop button. The only way was an auto-start toggle whose tooltip described boot behaviour | Explicit Stop, with confirmation |
| State legibility | 3px side stripe plus an 8px dot | Full keyed border, recessed surface, tube readout |
| Motion | Two infinite pulse animations | Nothing moves unless something changed |
| Type | System sans, plus a `Consolas, Monaco` mono stack that resolves on neither platform | Barlow Condensed and IBM Plex Mono, self-hosted |

### Deciding before generating

The first move was writing [ART-DIRECTION.md](../ART-DIRECTION.md) before
touching any markup. Three words — **ISSUED · LEGIBLE · UNFUSSY** — and one
constraint that turned out to govern everything:

> **This dashboard lives on a second monitor.** It is seen in peripheral vision
> more often than it is read. Anything that moves while nothing has changed is a
> defect.

That single sentence killed both of the original build's infinite pulse
animations, set the rule that motion is a signal rather than decoration, and
later settled an argument with myself about a chip ticker I'd built and liked.
I removed it. Motion at rest is a defect even when it's well-mannered.

### The name did work

SPNKr is Halo's M41 rocket launcher — two tubes and a handle. Stubby, mechanical,
unglamorous. **Equipment, not decoration.** That gave the whole thing a target:
warm gunmetal instead of consumer blue-black, 2px corners instead of 16px,
borders instead of shadows, and a wordmark that keeps the canonical lowercase r.

The mark is the launcher seen down the barrels. My first attempt was two level
circles, which I built from the name rather than the object — at 16px it read as
"oo", and once I had a real reference in front of me it was plainly wrong. The
bores are offset **diagonally** and the housing is rounded. The asymmetry is the
whole identity; a symmetric pair reads as goggles.

Then it earned its keep: **the mark's geometry recurs as the status readout on
every card** — two bars, staggered to echo the bores. Learn the logo and you can
read every server's state from across the room without reading a word.

### Making the spec enforceable

A checklist a human is supposed to tick off is a checklist nobody ticks off. Six
months from now a 16px radius comes back through one component and nothing can
tell a deliberate exception from a regression.

So `npm run design-check` turns the spec into **16 executable rules** — no
shadows, no looping motion, 2px corner cap, three semantic hues, every ink
measured against WCAG AA, no side-stripe borders. Zero dependencies, because the
Windows host has nothing installed but Node.

Exceptions are declared inline with a mandatory reason and **reprinted on every
run**, so they stay visible instead of rotting in a config file nobody opens:

```css
animation: chip-attention 2.6s ease-in-out infinite;
/* design-check: allow no-loop-motion — action chips are notifications of
   pending work, not ambient state; they vanish once resolved */
```

The rule I set for myself: **if a rule is wrong, change the rule *and* the spec
in the same commit.** A checker that contradicts its own spec trains you to
ignore it.

---

## What the redesign turned up

Design passes surface engineering problems, because you have to read everything.

**The repository could not start.** `src/db/database.js` was missing — ten
modules import it. The cause was `.gitignore` line 6: `db/`. Git patterns without
a leading slash match at *any* depth, so a rule meant for the SQLite data
directory at the project root had silently excluded `src/db/` too. The module was
reconstructed from the documented schema plus every call site.

**Player counts could report "unknown" as "zero".** The UDP fallback returned
`playerCount: 0` when its PowerShell call failed. Zero means *confirmed empty*,
and the idle monitor shuts down servers it believes are confirmed empty — so a
transient failure could have kicked players off a running game.

**An apostrophe broke the copy button.** The escaping helper escaped `&<>` but
not quotes, and its output was injected into an inline `onclick`. A password
containing `'` produced a syntactically invalid handler that threw on every
click. Fixed at the root: nothing interpolates user data into markup any more.

**The card grid was destroyed four times a minute.** It was rebuilt with
`innerHTML` on every status poll *and* every player poll, discarding hover,
focus, text selection and scroll position. Now it reconciles in place — 500
re-renders take 17.6ms with zero DOM growth.

**There was no way to stop a server.** The endpoint existed and was unused; the
only path was an auto-start toggle whose tooltip described boot behaviour.

---

## Handing setup to an agent

The genuinely tedious part of self-hosting is installing dedicated servers,
registering Windows services, and finding the right process name — Unreal games
spawn a `*-Win64-Shipping-Cmd.exe` from a small launcher, and pointing the
monitor at the launcher gives you a card that says "running" with no memory
reading.

That work is well suited to a coding agent, so the dashboard ships a **Setup
panel** with prompts ready to copy into Claude Code or Cursor. The prompts carry
the constraints that actually matter:

> Registering Windows services and adding firewall rules needs elevation, and the
> dashboard runs unelevated. Do not try to run those yourself — give me the exact
> commands and I'll run them in an admin terminal.

`AGENTS.md` carries the architectural invariants — the ones that break *silently*
rather than loudly, like the backup-retention sort order that once quietly
destroyed every new backup for weeks. An agent that reads it first won't
reintroduce a bug the project already fixed.

---

## What I'd tell you honestly

The frontend is verified end to end. There's a demo harness (`npm run demo`) that
serves the real UI against a synthetic fleet on any OS, which is how all of this
was designed and reviewed on a Mac.

**The Windows service layer is not verified.** NSSM, PowerShell, and the new
endpoints that touch them have never run against real services during this work.
They're additive and follow existing patterns, and their logic is exercised
through the demo against the real database — but that's not the same as running.
It's the first thing to check on the actual box.

I'd also flag that the four bundled banner images are 600px wide and upscale
slightly on a hi-dpi display, and that the event log only streams live for crash
events; everything else needs a manual refresh. Both are on the list.

---

## Stack

Node 18+, Express, Socket.IO, better-sqlite3, node-cron, discord.js, gamedig.
Frontend is vanilla HTML/CSS/JS — **no framework, no build step**, which is why
the design system is a stylesheet with a conformance checker rather than a
component library.
