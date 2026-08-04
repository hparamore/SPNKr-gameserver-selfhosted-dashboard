# Website blurb — SPNKr

Four paragraphs for a portfolio page. Trimmed and alternate versions below.

---

## Primary (4 paragraphs)

I was renting two dedicated game servers for about $30 a month, and that money
bought exactly two games — wanting to play a third meant paying for a third.
Meanwhile a perfectly good computer sat idle in the next room. SPNKr is the tool
that moved the whole arrangement onto that spare machine: no monthly fee, six
games instead of two, and friends who can bring a server up themselves from
Discord without a login or any idea what a Windows service is. The savings are
around $360 a year, but the real unlock was that the marginal cost of one more
game went to zero. We now run games nobody would have paid $15 a month to try.

The second half of the project was design. I'm working back through things I'd
already built and taking them out of default AI output — the look you get when
nothing was decided, only generated. The original was indigo on blue-black with
soft shadows, 16px corners, four stacked config rows per card, and two
animations that pulsed forever. It worked. It also looked like every other
generated dashboard, and it had no stop button: the only way to shut a server
down was a toggle whose label described boot behaviour.

I wrote the art direction before touching any markup. Three words — issued,
legible, unfussy — and one constraint that governed everything else: this thing
lives on a second monitor, so anything that moves while nothing has changed is a
defect. That single sentence killed both looping animations and later made me
delete a ticker I'd built and liked. The name carried the rest. SPNKr is Halo's
rocket launcher — two tubes and a handle, equipment rather than decoration — so
the palette went to gunmetal and amber, corners to 2px, shadows to borders, and
the mark became the launcher seen down the barrels. Then it earned its keep: the
mark's geometry recurs as the status readout on every card, so you can read a
server's state from across the room without reading a word.

Because a checklist nobody ticks off isn't a checklist, the spec is executable.
`npm run design-check` enforces sixteen rules with zero dependencies, and any
deliberate exception has to be declared inline with a reason that gets reprinted
on every run. The design pass also surfaced the engineering: the repository
couldn't actually start (a `.gitignore` pattern had silently excluded a source
directory), an apostrophe in a password broke the copy button, the card grid was
being destroyed and rebuilt four times a minute, and the player-count fallback
reported "unknown" as "zero" — which mattered, because the idle monitor shuts
down servers it believes are empty.

---

## Short version (2 paragraphs)

I was paying about $30 a month to rent two dedicated game servers. SPNKr moved
them onto a spare computer: no monthly fee, six games instead of two, and
friends who can start a server themselves from Discord. Around $360 a year
saved, but the real unlock was that adding a seventh game now costs nothing —
so we run games nobody would have paid to try.

The other half was a design pass, taking it out of default AI output. I wrote
the art direction before any markup, anchored on one constraint: this lives on a
second monitor, so anything that moves while nothing has changed is a defect.
The name did the rest — SPNKr is Halo's rocket launcher, equipment rather than
decoration — and the mark ended up doubling as the status readout on every card.
The spec is enforced by a zero-dependency checker, because a checklist nobody
ticks off isn't a checklist.

---

## One-liner

Self-hosted game server control. Replaced $30/month of rented hosting with a
spare PC running six games, controllable from Discord — then redesigned out of
default AI output, with the spec enforced by a zero-dependency checker.

---

## Pull quotes

> The marginal cost of a seventh game went to zero. When adding a server costs
> nothing, you add servers.

> This dashboard lives on a second monitor. Anything that moves while nothing
> has changed is a defect.

> A checklist a human is supposed to tick off is a checklist nobody ticks off.

> The design pass surfaced the engineering, because you have to read everything.

---

## Suggested images

| Image | Use |
|---|---|
| `screenshots/00-before-original-design.png` + `01-dashboard.png` | Before/after pair — same servers, same data, same viewport |
| `screenshots/01-dashboard.png` | Hero |
| `screenshots/02-dashboard-compact.png` | The dense reading, images off |
| `screenshots/03-configure.png` | Consolidation: four modals became one panel |
| `screenshots/05-setup-agent-prompts.png` | The agent-handoff angle |
| `screenshots/08-states-in-flight.png` | Motion as signal — the border sweep |
