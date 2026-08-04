# Screenshots

Captured at 2× from the demo harness. Regenerate any time with:

```bash
npm run demo         # terminal 1
npm run screenshots  # terminal 2
```

`scripts/screenshots.mjs` drives headless Chrome over the DevTools Protocol
using Node's built-in WebSocket — no Puppeteer or Playwright install.

| File | State |
|---|---|
| `00-before-original-design.png` | **The original UI**, before the redesign — captured from git history at commit `28d1fb8` |
| `01-dashboard.png` | Full dashboard, header images on |
| `02-dashboard-compact.png` | Header images off — the dense view |
| `03-configure.png` | Consolidated per-server configuration |
| `04-port-forwarding.png` | Router setup, deep-linked from the card's amber chip |
| `05-setup-agent-prompts.png` | Setup panel with copy-paste prompts for a coding agent |
| `06-view-options.png` | Global image toggle and server ordering |
| `07-image-cropper.png` | Built-in cropper, frame locked to the card's aspect |
| `08-states-in-flight.png` | Servers starting, stopping and updating |
| `09-link-lost.png` | Socket dropped — stale values flagged rather than silently shown |
| `10-empty-state.png` | No servers configured yet |
| `11-mobile.png` | Phone layout |
| `12-compact-configure.png` | Configure with images off — the Header Image section is removed entirely |
| `13-compact-states.png` | Compact view, servers mid-action |
| `14-compact-mobile.png` | Compact view on a phone |
| `15-compact-event-log.png` | Event log — the audit trail behind every action |

## Before / after

`00-before-original-design.png` and `01-dashboard.png` are the same six servers,
same data, same browser, same viewport. The differences are all design:

| | Before | After |
|---|---|---|
| Palette | Indigo `#6c63ff` on blue-black, five semantic hues | Gunmetal and amber, three semantic hues |
| Card height | Four stacked config rows, four separate modals | One `Configure` panel; roughly half the height |
| Stopping a server | No stop button — the only way was an auto-start toggle whose tooltip described boot behaviour | Explicit Stop, with confirmation |
| State legibility | 3px side stripe plus an 8px dot | Full keyed border, recessed surface, tube readout |
| Motion | Two infinite pulse animations | Nothing moves unless something changed |
| Type | System sans; a broken `Consolas, Monaco` mono stack that resolved on neither platform | Barlow Condensed for prose, IBM Plex Mono for machine values, self-hosted |

The side stripe in the "before" shot is worth noting: it's flagged as an
anti-pattern by design tooling, and it was in the original build.
