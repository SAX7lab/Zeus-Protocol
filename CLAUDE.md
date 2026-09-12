# ZEUS Protocol — working notes for Claude Code

Personal wellness app: daily agenda, routines, supplements, calendar
subscriptions, blood-panel tracking. Runs as **one self-contained HTML file**
served from GitHub Pages at `https://sax7lab.github.io/Zeus-Protocol/`,
added to the iPhone home screen as a web app.

`ROADMAP.md` holds the plan for the backend/multi-user phase. Read it before
starting anything in that direction.

---

## Hard constraints

**One file, no build step.** Everything lives in `index.html` — markup, CSS,
JavaScript. No bundler, no npm dependencies, no separate `.js` or `.css`.
The only permitted runtime fetches are pdf.js (cdnjs) and Tesseract.js
(jsDelivr), each loaded lazily and only when actually needed — pdf.js when a
PDF is opened, Tesseract.js only as a fallback when that PDF's text layer
comes back (almost) empty, i.e. it's a scan. Tesseract.js runs OCR entirely
in-browser via WASM, so biomarker data still never leaves the device — see
Privacy below. If a change seems to need a library beyond these two, say so
instead of adding one.

**Colours come from CSS variables only.** `var(--bg)`, `--surface`, `--ink`,
`--muted`, `--faint`, `--line`, `--frost`, `--moss`, `--clay`, `--amber`,
`--rose`. Never write a hex value into a rule; the dark theme breaks in
patches when you do. Exception: the literal `#14201d` fallbacks in `html, body`
and the `theme-color` meta, which exist deliberately for iOS.

**Always run `node --check` before finishing.** Extract the script block and
check it:

```bash
python3 -c "
import re
s = open('index.html').read()
open('/tmp/a.js','w').write(re.search(r'<script>(.*?)</script>', s, re.S).group(1))"
node --check /tmp/a.js
```

A syntax error ships as a blank white page on the phone, far from any console.
Check the CSS braces balance too when you touch styles.

---

## Data model

`DEFAULT_ROUTINES` and `DEFAULT_SUPPS` are the shipped defaults. `ROUTINES` and
`SUPP_BLOCKS` are the working copies, restored from local storage on load.

**Never assume a change to the defaults reaches the user.** Saved data shadows
them completely. New defaults arrive through `mergeNewDefaults()`, which adds
anything whose id is not yet in `seenDefaults`. That is also why a routine the
user deleted on purpose stays deleted. When adding a default, give it a stable
id and let the merge do its work — do not bump `DB_KEY`, that wipes real data.

Storage key is `zeus.protocol.v2`. Every write goes through `saveAll()`, called
at the end of `render()`. Reads happen once in `loadAll()`. Both are wrapped in
try/catch and fall back to memory when storage is blocked, so the app still
runs inside sandboxed previews.

Routines carry `{id, title, time, dur, cat, days?, date?, optional?, streak?}`.
`days` holds JS weekday numbers (0 = Sunday) even though the pickers display
Monday first. `date` set means a single-date entry; `cat: 'event'` marks a
calendar event, which uses a simplified edit sheet without category or kind.

Per-day state is keyed by date string: `state[dateKey][routineId]` for ticks,
`optOn[dateKey][routineId]` for which optional routines are switched on that
day. Optional routines reset every day by design.

The Supabase schema (phase 5) lives in `zeus-schema.sql` — never duplicate
table or policy definitions elsewhere, including in `ROADMAP.md`. Re-run
`rls-check.sql` after any change to tables or policies.

---

## Bio panel PDF import

`handlePdf()` is the entry point (file input onchange). It first tries
`pdfToLines()` — pdf.js text extraction — through `parseLines()`, the generic
Austrian-lab-report parser that anchors each value on its unit token (see the
comment above `UNIT_RE`; label rows like `Alpha-Globulin 1` or `CA 19-9` lose
their trailing digit to a naive "first number" approach).

If that comes back with zero parsed values — almost always because the PDF is
a scan with no text layer — `handlePdf()` falls back to `pdfToLinesOCR()`:
each page is rendered to a canvas via pdf.js, then read with Tesseract.js
(`deu+eng`, since Austrian labs report in German) through the same
`parseLines()` path. This is materially slower (seconds per page, plus a
one-time download of the OCR engine and language data on first use), so
`bioMsg` is updated per page rather than left on a single "Reading…" message.
Only when OCR *also* finds nothing does the user see the final "no values
found" message.

Both paths converge on `parseLines()` — do not duplicate its logic for the
OCR path; feed it the same line format (`pdfToLinesOCR` already runs OCR
output through `normaliseLine`, same as the pdf.js path).

---

## Privacy

Biomarker panels are health data and stay on the device. They are never sent
anywhere, and must not be added to any sync payload without an explicit
decision recorded in `ROADMAP.md`. This includes the OCR fallback above:
Tesseract.js processes pages locally in the browser via WASM — no page image
or extracted text is ever posted to a server.

Calendar feed URLs are secrets — anyone holding one can read the calendar
without authentication. They live in local storage only. Never commit one,
never write one into a comment or a test fixture.

---

## Style

Tone of the UI is **Mark II** — a Jarvis/Iron Man HUD: cold blue-white on
blue-black, cyan-tinted hairlines, bevelled (clip-path notched) corners rather
than rounded ones, mono uppercase for chrome and labels, system sans for body
prose. Colour carries atmosphere here, not only signal. Match what is already
there rather than introducing a new pattern.

This replaced an earlier "calm and sparse" direction (warm cream on green-black,
Georgia headings) in August 2026 — deliberately, at the user's request. Don't
"restore" the warm palette or the serif headings thinking they were lost.

Two rules the restyle depends on:

- **Glow is for edges and accents only.** Never on body text, and never on
  list rows — a blurred shadow per row is the usual cause of scroll jank.
- **`clip-path` clips `box-shadow` away entirely.** Anything bevelled that
  also needs to glow uses `filter: drop-shadow(...)`, which follows the clip.
  `.fab` is the worked example.

Still no web fonts: the one-file rule above means the sci-fi font shelf
(Orbitron, Rajdhani, …) is unavailable. The futurism is carried by colour,
geometry and the existing `--mono` system stack.

### The Nexus

The centrepiece view — seven domains orbiting the day's completion, in the
overlay on the phone and the right rail on desktop. It replaced the tilted
day-arc dial in August 2026, at the user's request. Two things about it are
load-bearing:

- **It draws `systemsReport()`, it does not compute anything.** Every domain,
  state and short value comes from that one function, which is also what the
  SYSTEMS block lists. That is deliberate: the two can never disagree. If a
  domain needs a new number, add it to `systemsReport()` — never derive one
  in the Nexus by re-reading the same data, and never by parsing its own
  `detail` sentence back apart.
- **Depth is computed, not CSS 3D.** Orbits are ellipses; a node's angle
  gives its distance from the viewer, which drives size and opacity. The old
  dial used a real `rotateX` on a `preserve-3d` disc and paid for it twice —
  layer divs at `translateZ` sat in front of the nodes in space and swallowed
  taps regardless of DOM order, and every label had to be counter-rotated to
  stay upright. Do not reintroduce `perspective` here.

Two smaller ones, both found the hard way: node emphasis uses plain vector
rings, never a per-node blur filter (seven filtered groups repositioned every
frame is exactly the jank the glow rule above warns about — the one filter in
the view is on the completion ring, which does not move); and the overlay's
`viewBox` is wider than the drawing on purpose, because labels sit outside
their node and a name like BLOOD PRESSURE on a node at the right flank runs
well past the rim.

Text in the interface is English. Code comments explain *why*, not *what* —
the non-obvious constraint, the browser quirk, the reason a regex looks odd.

---

## Things that have already gone wrong

- Flex children need `min-width: 0`, or time and number inputs overlap on
  narrow screens. The same rule must list **every** date/time input type —
  `datetime-local` was missed once and Safari, which unlike Chrome refuses to
  shrink such a control below its intrinsic width, pushed it clean through
  the side of its card. `appearance: none` on those types is load-bearing for
  a second reason: without it Safari ignores `text-align`.
- Safari reports a blocked fetch as `Load failed`, Chrome as `Failed to fetch`.
  Match both.
- Google and iCloud serve `.ics` without CORS headers. All calendar fetches go
  through the Cloudflare Worker proxy; a direct fetch always fails.
- Lab reports label rows like `Alpha-Globulin 1` and `CA 19-9`. Anchor value
  extraction on the unit token, not on the first number, or the label loses
  its trailing digit.
- Reaching into the app from a test harness: only `function` declarations
  land on `window`. Top-level `let`/`const` do not, and neither do
  `const` arrow functions — `activeRoutinesOn`, `allSupps`, `state`,
  `viewDate` are all unreachable from an iframe parent, and the resulting
  TypeError kills a promise chain silently. `collectState()` and
  `applyBackup()` are declarations, so those are the way in and out; seed
  fixtures through `localStorage[DB_KEY]` before the frame loads.
- Occasional controls sit ABOVE the primary content and the tab opens scrolled
  past them, via `id="scrollAnchor"` plus `ANCHORED_TABS` — Calendar anchors on
  the view switch, Bio on the blood-pressure card. This is deliberate (asked
  for in August 2026), not the old bug: an earlier version auto-scrolled the
  month grid and left the subscription card genuinely unreachable. The rule
  that survives is *reachable*, not *visible* — scrolling up must always get
  you back to them, so never trap the scroll or anchor below content the user
  needs. When a tab is too short to scroll, the controls simply stay in view;
  that is fine, do not pad the page to force it.
