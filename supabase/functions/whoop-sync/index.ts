// ZEUS Protocol — Whoop data sync (ROADMAP.md 5.3, the step after whoop-auth).
//
// Called by the client via supabase-js's functions.invoke('whoop-sync'),
// which attaches the caller's real Supabase session automatically —
// unlike whoop-auth/ingest, this needs no custom auth scheme, hence
// verify_jwt = true (supabase/config.toml). Still resolves the caller's
// own user id via auth.getUser() rather than trusting a decoded JWT
// payload directly.
//
// Pulls the last 30 days of cycles/recovery/sleep/workout from Whoop's
// v2 API (v1 404s on everything but /cycle — confirmed against the live
// API), merges them into per-day objects, and upserts into metrics with
// source='whoop' — the same table and shape Apple Health writes to, so
// the app's renderers don't care where a field came from.
//
// Never logs a token, a code, or a client secret. Only counts/outcomes.

import { createClient } from "@supabase/supabase-js";
import { ensureFreshWhoopToken, WHOOP_API_V2, localDayFromISO } from "../_shared/whoop.ts";

const DAYS_BACK = 30;
const MAX_PAGES = 20;

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, content-type, apikey, x-client-info",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}

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

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }
  if (req.method !== "POST") {
    return json({ ok: false, error: "Method not allowed. Use POST." }, 405);
  }

  const WHOOP_CLIENT_ID = Deno.env.get("WHOOP_CLIENT_ID");
  const WHOOP_CLIENT_SECRET = Deno.env.get("WHOOP_CLIENT_SECRET");
  const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
  const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
  const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  if (!WHOOP_CLIENT_ID || !WHOOP_CLIENT_SECRET) {
    console.error("whoop-sync: WHOOP_CLIENT_ID/WHOOP_CLIENT_SECRET not configured");
    return json({ ok: false, error: "Server is not configured for Whoop yet." }, 500);
  }

  const authHeader = req.headers.get("Authorization") || "";
  const token = authHeader.replace(/^Bearer\s+/i, "");
  if (!token) return json({ ok: false, error: "Missing session." }, 401);

  const anon = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  const { data: userData, error: userError } = await anon.auth.getUser(token);
  if (userError || !userData?.user) {
    return json({ ok: false, error: "Invalid or expired session." }, 401);
  }
  const userId = userData.user.id;

  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  });

  const tokenRow = await ensureFreshWhoopToken(admin, userId, WHOOP_CLIENT_ID, WHOOP_CLIENT_SECRET);
  if (!tokenRow) {
    return json({ ok: false, error: "Whoop is not connected." }, 409);
  }

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
    console.error("whoop-sync: fetching from Whoop failed");
    return json({ ok: false, error: "Could not fetch data from Whoop. Try again." }, 502);
  }

  const byDay: Record<string, Record<string, unknown>> = {};
  const dayOf = (d: string) => (byDay[d] ??= {});

  // cycle_id -> day. Recovery carries no timezone_offset of its own, so it
  // is bucketed via the cycle it belongs to rather than its created_at.
  const cycleDay: Record<number, string> = {};
  for (const c of cycles) {
    if (c.score_state !== "SCORED" || !c.score) continue;
    const day = localDayFromISO(c.start, c.timezone_offset);
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

  // The main nightly sleep, per day: the longest non-nap record, so a nap
  // logged the same day never overwrites the real sleep score.
  const mainSleepByDay: Record<string, { record: Record<string, any>; durationMs: number }> = {};
  for (const s of sleeps) {
    if (s.score_state !== "SCORED" || !s.score || s.nap) continue;
    const day = localDayFromISO(s.start, s.timezone_offset);
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
    if (upsertError) {
      console.error("whoop-sync: metrics upsert failed, rows:", rows.length);
      return json({ ok: false, error: "Could not save Whoop data." }, 500);
    }
  }

  const { error: touchError } = await admin
    .from("whoop_tokens")
    .update({ last_sync: nowIso })
    .eq("user_id", userId);
  if (touchError) console.error("whoop-sync: last_sync update failed");

  console.log("whoop-sync: wrote", rows.length, "day(s)");
  return json({ ok: true, written: rows.length });
});
