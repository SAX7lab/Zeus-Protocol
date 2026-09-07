// ZEUS Protocol — Whoop OAuth + API helpers (ROADMAP.md 5.3).
//
// Shared between whoop-auth (connect/callback) and whoop-sync (reads
// cycles/recovery/sleep/workout into metrics). Nothing here logs a
// token, a code, or a client secret; callers should stick to logging
// counts and outcomes.

import type { SupabaseClient } from "@supabase/supabase-js";

export const WHOOP_AUTH_URL = "https://api.prod.whoop.com/oauth/oauth2/auth";
export const WHOOP_TOKEN_URL = "https://api.prod.whoop.com/oauth/oauth2/token";
export const WHOOP_PROFILE_URL = "https://api.prod.whoop.com/developer/v1/user/profile/basic";
export const WHOOP_SCOPES = "offline read:profile read:sleep read:recovery read:cycles read:workout";

// v1 still serves /cycle but 404s on /recovery, /activity/sleep and
// /activity/workout — confirmed against the live API on 2026-09-07.
// v2 serves all four, so everything here uses v2 for consistency.
export const WHOOP_API_V2 = "https://api.prod.whoop.com/developer/v2";

// Whoop timestamps are UTC; timezone_offset is a "+HH:MM"/"-HH:MM"
// string on cycle/sleep/workout records (not on recovery — recovery is
// bucketed by its cycle's day instead, via cycle_id, in whoop-sync).
// Returns a YYYY-MM-DD local-date string, matching metrics.day's format
// and index.html's key(Date) convention.
export function localDayFromISO(iso: string, timezoneOffset: string): string {
  const sign = timezoneOffset.startsWith("-") ? -1 : 1;
  const [oh, om] = timezoneOffset.slice(1).split(":").map(Number);
  const offsetMs = sign * ((oh * 60 + om) * 60000);
  const local = new Date(new Date(iso).getTime() + offsetMs);
  const y = local.getUTCFullYear();
  const m = String(local.getUTCMonth() + 1).padStart(2, "0");
  const d = String(local.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export interface WhoopTokenRow {
  user_id: string;
  access_token: string;
  refresh_token: string;
  expires_at: string;
  whoop_user_id: string | null;
  connected_at: string;
  last_sync: string | null;
}

interface WhoopTokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  token_type: string;
  scope?: string;
}

async function hmacHex(key: string, message: string): Promise<string> {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", cryptoKey, new TextEncoder().encode(message));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// No early exit — walks the full length of the longer string regardless
// of where the first mismatch is, so comparison timing does not leak it.
export function timingSafeEqual(a: string, b: string): boolean {
  const len = Math.max(a.length, b.length);
  let diff = a.length ^ b.length;
  for (let i = 0; i < len; i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
}

// ---- signed state ----
// Carries the user id across the redirect to Whoop and back, so the
// callback (which Whoop calls with no Supabase session at all) knows
// whose connection this is, without a server-side session store. Keyed
// on WHOOP_CLIENT_SECRET deliberately — it is already a secret scoped to
// exactly this OAuth flow, so no separate signing secret to provision.
export async function signState(userId: string, secret: string): Promise<string> {
  const payload = `${userId}.${Date.now()}`;
  const sig = await hmacHex(secret, payload);
  return btoa(payload) + "." + sig;
}

export async function verifyState(
  state: string,
  secret: string,
  maxAgeMs: number,
): Promise<{ userId: string } | null> {
  const [encodedPayload, sig] = state.split(".");
  if (!encodedPayload || !sig) return null;
  let payload: string;
  try {
    payload = atob(encodedPayload);
  } catch {
    return null;
  }
  const expectedSig = await hmacHex(secret, payload);
  if (!timingSafeEqual(sig, expectedSig)) return null;
  const [userId, iatStr] = payload.split(".");
  const iat = Number(iatStr);
  if (!userId || !Number.isFinite(iat)) return null;
  if (Date.now() - iat > maxAgeMs) return null;
  return { userId };
}

export async function exchangeCodeForTokens(
  code: string,
  redirectUri: string,
  clientId: string,
  clientSecret: string,
): Promise<WhoopTokenResponse> {
  const res = await fetch(WHOOP_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      client_id: clientId,
      client_secret: clientSecret,
    }),
  });
  if (!res.ok) throw new Error(`Whoop token exchange failed (${res.status})`);
  return await res.json();
}

// Whoop rotates the refresh token on every use — the caller MUST persist
// the new one from this response, or the old one stops working and the
// user has to reconnect by hand. Whoop's docs ask for `scope` on a
// refresh request too, not just grant_type/refresh_token.
export async function refreshWhoopTokens(
  refreshToken: string,
  clientId: string,
  clientSecret: string,
): Promise<WhoopTokenResponse> {
  const res = await fetch(WHOOP_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: clientId,
      client_secret: clientSecret,
      scope: WHOOP_SCOPES,
    }),
  });
  if (!res.ok) throw new Error(`Whoop token refresh failed (${res.status})`);
  return await res.json();
}

export async function fetchWhoopUserId(accessToken: string): Promise<string | null> {
  try {
    const res = await fetch(WHOOP_PROFILE_URL, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data && data.user_id != null ? String(data.user_id) : null;
  } catch {
    return null;
  }
}

// Returns a row guaranteed to have an access_token valid for at least
// 5 more minutes, refreshing and persisting first if needed. Returns
// null if this user has no Whoop connection at all. Used by
// syncWhoopUser() below, called from both whoop-sync (one user, JWT) and
// whoop-sync-all (every connected user, service-role, scheduled).
export async function ensureFreshWhoopToken(
  admin: SupabaseClient,
  userId: string,
  clientId: string,
  clientSecret: string,
): Promise<WhoopTokenRow | null> {
  const { data: row, error } = await admin
    .from("whoop_tokens")
    .select("*")
    .eq("user_id", userId)
    .maybeSingle();
  if (error || !row) return null;

  const fiveMinMs = 5 * 60 * 1000;
  if (new Date(row.expires_at).getTime() - Date.now() > fiveMinMs) {
    return row as WhoopTokenRow;
  }

  const fresh = await refreshWhoopTokens(row.refresh_token, clientId, clientSecret);
  const updated = {
    access_token: fresh.access_token,
    refresh_token: fresh.refresh_token,
    expires_at: new Date(Date.now() + fresh.expires_in * 1000).toISOString(),
  };
  const { error: updateError } = await admin
    .from("whoop_tokens")
    .update(updated)
    .eq("user_id", userId);
  if (updateError) throw updateError;
  return { ...(row as WhoopTokenRow), ...updated };
}

// ---- sync ----

const DAYS_BACK = 30;
const MAX_PAGES = 20;

interface WhoopCollectionResponse {
  records: Record<string, any>[];
  next_token?: string | null;
}

async function fetchWhoopRecords(
  path: string,
  accessToken: string,
  sinceIso: string,
): Promise<Record<string, any>[]> {
  const records: Record<string, any>[] = [];
  const limit = 25;
  let nextToken: string | null = null;
  let page = 0;
  while (page < MAX_PAGES) {
    const url = new URL(`${WHOOP_API_V2}${path}`);
    url.searchParams.set("start", sinceIso);
    url.searchParams.set("limit", String(limit));
    if (nextToken) url.searchParams.set("next_token", nextToken);
    const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
    if (!res.ok) throw new Error(`Whoop ${path} failed (${res.status})`);
    const data: WhoopCollectionResponse = await res.json();
    const pageRecords = data.records || [];
    records.push(...pageRecords);
    page++;
    const newToken = data.next_token || null;
    // Confirmed against the live API: Whoop can hand back a next_token
    // that doesn't advance (or a token at all) on a result that already
    // fits on one page. Without this, a non-advancing cursor re-fetches
    // the same page until MAX_PAGES, duplicating every record on it —
    // exactly what happened to a day's workouts before this fix. A short
    // page (fewer records than the limit) is also, on its own, always
    // the last one — no API needs to be asked twice to know that.
    if (!newToken || newToken === nextToken || pageRecords.length < limit) break;
    nextToken = newToken;
  }
  return records;
}

export interface WhoopSyncResult {
  ok: true;
  written: number;
}
export interface WhoopSyncError {
  ok: false;
  error: string;
}

// Pulls the last 30 days of cycle/recovery/sleep/workout for one user and
// upserts them into metrics (source='whoop'). Shared by whoop-sync (one
// user, called from the client) and whoop-sync-all (every connected user,
// called on a schedule) — see those files for how each resolves userId
// and authenticates its caller; this function trusts the userId it's
// given completely, so neither should call it without having verified
// the caller first.
export async function syncWhoopUser(
  admin: SupabaseClient,
  userId: string,
  clientId: string,
  clientSecret: string,
): Promise<WhoopSyncResult | WhoopSyncError> {
  const tokenRow = await ensureFreshWhoopToken(admin, userId, clientId, clientSecret);
  if (!tokenRow) return { ok: false, error: "Whoop is not connected." };

  const since = new Date();
  since.setDate(since.getDate() - DAYS_BACK);
  const sinceIso = since.toISOString();

  let cycles: Record<string, any>[], recoveries: Record<string, any>[];
  let sleeps: Record<string, any>[], workouts: Record<string, any>[];
  try {
    [cycles, recoveries, sleeps, workouts] = await Promise.all([
      fetchWhoopRecords("/cycle", tokenRow.access_token, sinceIso),
      fetchWhoopRecords("/recovery", tokenRow.access_token, sinceIso),
      fetchWhoopRecords("/activity/sleep", tokenRow.access_token, sinceIso),
      fetchWhoopRecords("/activity/workout", tokenRow.access_token, sinceIso),
    ]);
  } catch {
    return { ok: false, error: "Could not fetch data from Whoop. Try again." };
  }

  const byDay: Record<string, Record<string, unknown>> = {};
  const dayOf = (d: string) => (byDay[d] ??= {});

  // cycle_id -> day. Bucketed by created_at, not start: a cycle STARTS the
  // evening before (sleep onset) but is finalized — created_at — after
  // waking, which is the day it actually belongs to. Bucketing by start
  // put every cycle/sleep/recovery one day early (confirmed against a
  // real account: today's ongoing cycle had start = yesterday evening,
  // created_at = this morning). Recovery carries no timezone_offset of
  // its own, so it is bucketed via the cycle it belongs to either way.
  const cycleDay: Record<number, string> = {};
  for (const c of cycles) {
    if (c.score_state !== "SCORED" || !c.score) continue;
    const day = localDayFromISO(c.created_at, c.timezone_offset);
    cycleDay[c.id] = day;
    const d = dayOf(day);
    d.strain = c.score.strain;
    d.calories = Math.round(c.score.kilojoule / 4.184);
    d.avg_heart_rate = c.score.average_heart_rate;
    d.max_heart_rate = c.score.max_heart_rate;
  }

  for (const r of recoveries) {
    if (r.score_state !== "SCORED" || !r.score) continue;
    const day = cycleDay[r.cycle_id];
    if (!day) continue;
    const d = dayOf(day);
    d.recovery_score = r.score.recovery_score;
    d.resting_heart_rate = r.score.resting_heart_rate;
    d.hrv_rmssd_milli = r.score.hrv_rmssd_milli;
    d.spo2_percentage = r.score.spo2_percentage;
  }

  // Same created_at reasoning as cycles above — sleep also starts the
  // evening before. The main nightly sleep per day is the longest
  // non-nap record, so a nap logged the same day never overwrites it.
  const mainSleepByDay: Record<string, { record: Record<string, any>; durationMs: number }> = {};
  for (const s of sleeps) {
    if (s.score_state !== "SCORED" || !s.score || s.nap) continue;
    const day = localDayFromISO(s.created_at, s.timezone_offset);
    const durationMs = new Date(s.end).getTime() - new Date(s.start).getTime();
    const existing = mainSleepByDay[day];
    if (!existing || durationMs > existing.durationMs) {
      mainSleepByDay[day] = { record: s, durationMs };
    }
  }
  for (const day in mainSleepByDay) {
    const s = mainSleepByDay[day].record;
    const d = dayOf(day);
    d.sleep_performance_percentage = s.score.sleep_performance_percentage;
    d.sleep_efficiency_percentage = s.score.sleep_efficiency_percentage;
    d.sleep_consistency_percentage = s.score.sleep_consistency_percentage;
    d.respiratory_rate = s.score.respiratory_rate;
    const ss = s.score.stage_summary;
    if (ss) {
      d.time_in_bed_minutes = Math.round(ss.total_in_bed_time_milli / 60000);
      d.time_asleep_minutes = Math.round(
        (ss.total_light_sleep_time_milli + ss.total_slow_wave_sleep_time_milli +
          ss.total_rem_sleep_time_milli) / 60000,
      );
    }
  }

  // Workouts happen during the day, not spanning midnight the way sleep
  // does, so start's own local date (not created_at) is the right day.
  for (const w of workouts) {
    if (w.score_state !== "SCORED" || !w.score) continue;
    const day = localDayFromISO(w.start, w.timezone_offset);
    const d = dayOf(day) as { workouts?: Record<string, unknown>[] };
    (d.workouts ??= []).push({
      sport: w.sport_name,
      strain: w.score.strain,
      calories: Math.round(w.score.kilojoule / 4.184),
      minutes: Math.round((new Date(w.end).getTime() - new Date(w.start).getTime()) / 60000),
    });
  }

  const nowIso = new Date().toISOString();
  const rows = Object.keys(byDay).map((day) => ({
    user_id: userId,
    day,
    source: "whoop",
    data: byDay[day],
    updated_at: nowIso,
  }));

  if (rows.length) {
    const { error: upsertError } = await admin
      .from("metrics")
      .upsert(rows, { onConflict: "user_id,day,source" });
    if (upsertError) return { ok: false, error: "Could not save Whoop data." };
  }

  const { error: touchError } = await admin
    .from("whoop_tokens")
    .update({ last_sync: nowIso })
    .eq("user_id", userId);
  if (touchError) {
    // Not fatal — the metrics write already succeeded.
    console.error("syncWhoopUser: last_sync update failed");
  }

  return { ok: true, written: rows.length };
}
