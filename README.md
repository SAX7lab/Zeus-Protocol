# Zeus-Protocol

ZEUS Protocol is a personal wellness tracker built as a single self-contained
HTML file — no build step, no framework — served from GitHub Pages and added
to the iPhone home screen as a web app.

**Agenda** merges routines, supplement blocks and calendar events into one
timeline, with a live eating-window countdown. **Routines** support optional
items you switch on per day, weekday scheduling and streak counters.
**Supplements** are grouped into timed blocks with doses. **Calendar**
subscribes to iCal feeds through a Cloudflare Worker proxy, with month and day
views. **Bio** reads biomarkers from lab PDFs — including scanned reports with
no text layer, via an in-browser OCR fallback (Tesseract.js) — and compares
them against previous panels, alongside blood pressure tracking.
**Integrations** shows Whoop recovery/sleep/strain as rings and 30-day trend
charts, and Apple Health data (steps, workout minutes) delivered through an
Apple Shortcut. The Nexus view visualises the day's completion across all
domains at a glance.

Accounts run on Supabase (hosted in the EU), with local-first sync: the app
works fully offline from local storage and syncs on sign-in. A GDPR consent
gate, privacy page and account-deletion flow are built in. **Biomarker data
never leaves the device** — it stays in local storage only, whether or not
you're signed in. Each account can personalise which tabs are shown and
rename the app to their own "___'s Protocol".

Live at `https://sax7sunny.github.io/Zeus-Protocol/`.

## Status

Actively developed. Core tracking (Agenda/Routines/Supplements/Calendar/Bio)
and the Supabase backend (accounts, sync, GDPR) are deployed. Whoop and Apple
Health integrations are deployed and verified against real connected
accounts; Whoop is currently gated by its developer test-user cap for anyone
other than the maintainer, until the app is approved for production by Whoop.

See `ROADMAP.md` for what's shipped, in progress, and deliberately deferred
(a native app shell, home-screen widgets), and `CLAUDE.md` for the
constraints and conventions the codebase follows.
