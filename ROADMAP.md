# ZEUS Protocol — Roadmap

## Status

**Phase 5 — backend, accounts, integrations (current), as of 2026-09-07.**
5.1 (Supabase accounts with local-first sync), 5.2 (GDPR consent gating) and
5.4 (per-user personalisation) are deployed and working. **5.3 is mostly
done:** Apple Health (`ingest`, device tokens) and Whoop (OAuth connect +
`whoop-sync` data sync) both write into `metrics`, and the app has a real
Integrations tab — Whoop-style rings for recovery/sleep, strain, 30-day
trend charts, real Connect/Sync actions — moved out of Bio, which now
holds only biomarker panels and blood pressure. Verified end-to-end
against the operator's own connected Whoop account, including a
day-attribution fix and twice-daily scheduled syncing, both **deployed
and verified 2026-09-07** — see below. Still open: the actual Apple
Shortcut running on-device (data only arrives when it's manually
triggered so far); Eight Sleep stays deferred.

**Phase 6** exists as a later option, not a commitment: packaging the web app
properly, from PWA polish up to a native shell. Only 6.1 is a given; anything
beyond it depends on whether native Apple Health access turns out to be worth
its cost.

---

## Phase 5 — backend, accounts, integrations

The unifying idea: **the backend needed for multiple users is the same backend
that unlocks the device integrations.** Whoop and Apple Health both failed
until now for lack of a server-side component, not for lack of app code.

### 5.1 Foundation — Supabase

- Project in **eu-central-1 (Frankfurt)**, so data stays in the EU.
- Auth: email + password via `supabase-js` from CDN.
- Schema: one JSON row per user, mirroring what `saveAll()` already writes.
  Full schema and RLS policies live in `zeus-schema.sql` — do not duplicate
  them here.

**Deployed and verified.** Schema and policies are live on the Supabase
project (eu-central-1). RLS verified 2026-08-17 via `rls-check.sql`: reads
are scoped per user, and cross-user writes are rejected.

- Sync: local-first. Load on start, push on change.
- **Free tier pauses after 7 days of inactivity.** Keep alive with a GitHub
  Actions cron hitting the DB every 3 days (free on a public repo).
- **Free tier has no backups.** The JSON export stays the only safety net.

### 5.2 Test users and GDPR

- Consent gate after signup: no access until a row exists in `consents`.
  Store a `version` so the prompt can reappear when the text changes.
- Required alongside the consent button, not instead of it:
  - a privacy page stating what is stored, where, and for how long
  - a working **delete my account** button (cascades via `on delete cascade`)
  - data export on request — the JSON export covers this
- **Biomarkers stay device-local.** Never uploaded. This keeps Article 9
  health data out of the server entirely and removes most obligations.
  Revisit only with legal advice.

### 5.3 Integrations

| Source | Path | Notes |
|---|---|---|
| **Apple Health** | Shortcuts automation → POST to Edge Function | Only viable route; HealthKit has no web API. Each user installs the Shortcut once. Priority. Ingest side and the read-back into the app are **deployed and verified 2026-09-05/07** — see below. Still open: the Shortcut itself, running on-device. |
| **Whoop** | OAuth 2.0 authorization code via Edge Function | Public API exists. Client secret lives server-side; function handles token refresh. Connect flow, data sync, day-attribution fix and scheduled sync **deployed and verified 2026-09-07** — see below. |
| **Eight Sleep** | Deferred | No official API. Unofficial endpoints need account credentials — not acceptable for other people's accounts. Self-use only, if at all. |

Store fetched metrics per user and per day, keyed by source, so the agenda and
Bio tab can read them without caring where they came from.

**Ingest foundation deployed and verified (2026-09-05).** `metrics` and
`device_tokens` (schema in `zeus-schema.sql`, RLS-scoped to their owner) and
the `ingest` Edge Function (`supabase/functions/ingest`) are live on the
linked project. The function hashes a presented device token (SHA-256,
constant-time compare) to resolve a `user_id`, then upserts into `metrics`
on `(user_id, day, source)` with the service-role key — never exposed to a
client. Verified end-to-end against a throwaway test account (created and
deleted via the Admin API): CORS, auth rejection paths, payload validation,
a real multi-day write, upsert-replace, and revoked-token rejection.
`index.html`'s account panel has a **Connections** section to generate,
list and revoke these device tokens; the plaintext is shown once and never
persisted anywhere.

**Read-back deployed and verified (2026-09-07).** `cloudFetchMetrics()`
pulls the last 30 days into a local `METRICS` object (day → source → data)
on sign-in and on every sync — read-only, cloud-only, empty signed out.
Bio gets an Activity card above the biomarker panels (steps, workout
minutes, 7-day-average delta, a 30-day bar chart per metric, "Synced
HH:MM" / "Last sync N days ago" past 36h so a silently broken Shortcut is
visible); the Agenda gets a compact steps/workout-minutes line, today
only. Nothing assumes `source === 'apple_health'` — fields are merged
across whatever sources exist for a day, so Whoop only has to start
writing to the same table.

**Whoop connect flow deployed and verified (2026-09-07).** `whoop_tokens`
(schema in `zeus-schema.sql`, one row per user, RLS-scoped to its owner —
the table's comment is explicit that the client must never select
`access_token`/`refresh_token`, only connection status) and the
`whoop-auth` Edge Function (`supabase/functions/whoop-auth`) are live.
`?start=1&access_token=<jwt>` validates the caller and 302s to Whoop with
a signed, timestamped state (HMAC-SHA256 keyed on `WHOOP_CLIENT_SECRET`,
rejected past 10 minutes); the callback verifies that state, exchanges
the code, stores the tokens with the service-role key, and 302s to
`connected.html`. `supabase/functions/_shared/whoop.ts` has
`ensureFreshWhoopToken()` — refreshes within 5 minutes of expiry and
persists Whoop's rotated refresh token every time.

**Data sync deployed and verified (2026-09-07).** `whoop-sync`
(`supabase/functions/whoop-sync`, `verify_jwt = true` — called by the
client's own authenticated supabase-js instance, unlike whoop-auth's
custom scheme) pulls the last 30 days of cycle/recovery/sleep/workout
from Whoop's v2 API (v1 404s on everything but `/cycle`) and merges them
into `metrics` with `source='whoop'` — the same table Apple Health
writes to, so nothing downstream assumes either source. Found and fixed
mid-build against the operator's real connected account: Whoop can hand
back a `next_token` that doesn't advance on a single-page result, and the
original pagination loop kept re-fetching that page until its cap,
duplicating every workout on it exactly 20x (every stored count was a
multiple of 20 — that's how it was caught). Fixed by also stopping when
the token doesn't change or a page returns fewer records than requested;
re-running the sync self-healed the affected rows via the upsert.

**Day-attribution bug found and fixed (2026-09-07).** Every cycle/sleep/
recovery entry was landing one day early — today's data showing as
yesterday's. Whoop's `cycle` and `sleep` records carry a `start` timestamp
from the previous evening (sleep onset) but a `created_at` timestamp from
when Whoop actually scores the record, after waking — the day it belongs
to. The sync bucketed by `start`; confirmed against a real cycle
(`start` 06:05 the day before, `created_at` 06:05 the morning of) and
fixed by bucketing cycles and sleep on `created_at` instead. `workout`
records are untouched — they happen during the day, so `start` was
already the right day for them.

**Scheduled sync deployed and verified (2026-09-07).** The sync body moved
out of `whoop-sync/index.ts` into `syncWhoopUser()` in
`supabase/functions/_shared/whoop.ts`, shared by two Edge Functions:
`whoop-sync` (one user, the caller's own JWT — unchanged contract, still
what the "Sync now" button calls) and the new `whoop-sync-all` (every
connected account). `whoop-sync-all` authenticates the caller against a
dedicated `CRON_SECRET` (random, `supabase secrets set`) rather than the
service-role key — tried that first, but this project has both legacy JWT
and newer-format API keys and the value Edge Functions see at runtime
matched neither candidate fetched via the CLI; a purpose-built secret
sidesteps that and is better scoped anyway, since a leaked cron secret can
only trigger a sync, not read the database. `.github/workflows/whoop-sync.yml`
calls `whoop-sync-all` on a cron at 05:00 and 19:00 UTC (~7am/9pm CEST —
revisit the cron lines once CET/winter DST matters), authenticated with a
`CRON_SECRET` GitHub Actions secret holding the same value, same
retry-a-paused-project pattern as `keep-alive.yml`. Verified via
`workflow_dispatch`: `{"ok":true,"accounts":1,"synced":1,"failed":0,"written":25}`.

The app's Integrations tab (new: a 7th entry in `SECTION_KEYS`, its own
tab button, collapsible in Personalisation like every other section)
replaces the old inert "Connect" placeholders under Bio with a real
dashboard: Whoop as circular recovery/sleep rings (moss/amber/rose by
band, a flat "—" rather than a misleading 0% ring when a day has no
score yet — this morning's cycle, for instance) plus a plain strain
number and 30-day trend bars; Apple Health's card (moved from Bio,
gained prev/next day navigation arrows); Eight Sleep, still just the
explanatory not-connected note. Bio now holds only biomarker panels and
blood pressure. Verified against the operator's real, currently-connected
Whoop account: real rings render real recovery/sleep/strain values for
a day that has them, correctly read "—" for today's still-unscored cycle,
and the dashboard is reachable through a real sign-in that persisted
across a reload of the live GitHub Pages deployment.

### 5.4 Personalisation

- `display_name` in the profile. Header shows **"Mike's Protocol"** instead of
  "ZEUS Protocol"; fall back to "ZEUS Protocol" when unset.
- Per-user section toggles: each tab (Agenda, Routine, Supplements, Tasks,
  Calendar, Bio, Integrations) can be switched off and disappears from the
  tab bar; at least one must stay on.
- Bio tab specifically: off by default for new users, since most will not
  upload lab reports.
- Defaults: new accounts start from `DEFAULT_ROUTINES` / `DEFAULT_SUPPS`, then
  diverge freely. The existing `seenDefaults` merge logic already handles
  shipping new defaults without overwriting user edits.

---

## Phase 6 — packaging as a real app

Three routes, cheapest first (6.1–6.3), then one feature that depends on
which route is taken (6.4). Not urgent: the web app already works from the
home screen.

### 6.1 PWA polish — do this regardless

A `manifest.json` plus a service worker. Gives offline operation, a proper
splash screen and a native-feeling launch. Costs nothing, needs no App Store,
and barely touches the existing file. It is also the foundation the other two
routes build on.

Limits: no HealthKit, no background sync, notifications only partially
supported on iOS.

### 6.2 Capacitor — the realistic candidate

A native shell around the existing web app. HTML, CSS and JavaScript stay as
they are, but native APIs become reachable — **including HealthKit**, which is
the one thing the Shortcuts workaround in 5.3 only approximates.

Costs: Xcode on the Mac mini, Apple Developer Program at €99/year, and App
Store review, which is stricter for health apps. The "one file, no build step"
constraint in `CLAUDE.md` no longer holds — Capacitor requires a project
structure. That trade-off should be a deliberate decision, not a side effect.

### 6.3 Native rewrite — not worth it

Swift or React Native. Best performance, but starts from zero and discards
everything built so far. Recorded only for completeness.

### 6.4 Home-screen widgets — wanted, blocked twice over

Asked for in August 2026. Not possible from the current architecture, for two
independent reasons, and the second is the one that bites:

**Rendering.** iOS widgets exist only through WidgetKit, in SwiftUI. There is
no web API for them and none is coming from Apple. Under iOS 26 a site added
to the home screen opens as a web app by default, but that changes nothing
here — widgets stayed native. (Windows does support PWA widgets; Apple does
not, so anything written about "PWA widgets" generally does not apply to
iPhone.)

**Data.** Everything lives in `localStorage` under this origin. No other
process on the phone can read it, a native widget included. So a widget is
gated on phase 5 first: there has to be a data source reachable from outside
the browser before there is anything to render.

Routes, once phase 5 exists:

- **Scriptable** — widgets written in JavaScript, reading a URL. Free, no
  App Store, no €99/year. Cheapest way to get "next up" or the day's
  percentage onto the home screen, and it needs no change to this repo
  beyond an endpoint to read.
- **Capacitor plus a WidgetKit extension** — the real thing. Shares data with
  the widget through an App Group. Only sensible if 6.2 happens anyway; the
  widget alone does not justify its costs.
- **Shortcuts** — not a widget, but a home-screen shortcut can surface a
  value. Ugly, works today, worth remembering as a stopgap.

Sequencing: **do not start this before phase 5.** Building it against
`localStorage` means building it twice.

### Decision point

Whether to go beyond 6.1 hinges on one question: **is native Apple Health
access worth €99/year and losing the single-file architecture?** If the
Shortcuts route from 5.3 proves good enough in daily use, stop at the PWA. If
it turns out to be too much friction — especially once other people have to
install a Shortcut of their own — Capacitor becomes the answer.

A second, non-technical argument: distributing through the App Store reaches
people who will not save a URL to their home screen. That matters only once
there are real users.

Home-screen widgets (6.4) now sit on the Capacitor side of this decision too —
Scriptable can cover the simple cases without it, but only after phase 5.

---

## Constraints that must survive any rewrite

- Single self-contained HTML file — no build step, no bundler.
- Colours only via CSS variables, never hardcoded hex.
- `node --check` on the extracted script block after every change.
- Never edit `DEFAULT_ROUTINES` without considering the `seenDefaults` merge.
- Secrets — calendar URLs, API tokens — never in the repo.
