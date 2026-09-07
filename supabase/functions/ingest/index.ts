// ZEUS Protocol — metrics ingest (ROADMAP.md 5.3: Apple Health, Whoop).
//
// The Apple Shortcut that runs this daily cannot hold a Supabase session:
// access tokens expire after about an hour, so a session-based automation
// would break overnight. It carries a long-lived device token instead
// (device_tokens in zeus-schema.sql) — this function's whole job is to
// turn that token into a user_id, then write with the service-role key,
// which is only ever read from an env var here and never reaches a client.
//
// verify_jwt is off for this function (supabase/config.toml) since the
// caller never has a Supabase JWT at all — Authorization carries the
// device token instead, checked by hand below.
//
// Never logs a token value or payload contents to the server console —
// this is health-adjacent data. Only counts and outcomes. The one
// exception is the debug echo below, which returns the caller's own
// submitted body back to that same caller in the HTTP response — never
// written to a log — when they opt in with "debug":true.
//
// 2026-09-08 postmortem: a request that looked byte-identical to a valid
// one was rejected with the "source" error. Reproduced two causes, both
// invisible in a Shortcut's own preview: the whole JSON body pasted into
// a single Text field instead of built as a dictionary (so top-level
// "source" doesn't exist — it's buried inside a string), and a trailing
// newline Shortcuts' Text fields are prone to adding ("apple_health\n").
// Fixed by trimming/lowercasing before comparing rather than trusting
// exact equality, and error messages now name the actual field, its
// received value (via JSON.stringify, so invisible characters show up
// as escapes) and its type — the old message blamed "source" even when
// the fault was elsewhere.

import { createClient } from "@supabase/supabase-js";

const MAX_DAYS = 60;
const MAX_BODY_BYTES = 100 * 1024;
const ALLOWED_SOURCES = ["apple_health", "whoop"];
const PREVIEW_LIMIT = 300;

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, content-type",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}

// JSON.stringify escapes control characters and BOM as \uXXXX, which is
// exactly what makes invisible whitespace visible in an error message.
// Truncated so a single oversized field can't blow up a response.
function preview(v: unknown): string {
  let s: string;
  try {
    s = JSON.stringify(v);
  } catch {
    s = String(v);
  }
  if (s === undefined) s = "undefined";
  return s.length > PREVIEW_LIMIT ? s.slice(0, PREVIEW_LIMIT) + "…(truncated)" : s;
}

async function sha256Hex(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Manual constant-time compare: always walks the full length of the
// longer string with no early exit, so how many leading characters
// matched never shows up as a timing difference.
function timingSafeEqualHex(a: string, b: string): boolean {
  const len = Math.max(a.length, b.length);
  let diff = a.length ^ b.length;
  for (let i = 0; i < len; i++) {
    diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  }
  return diff === 0;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isValidDay(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  return !Number.isNaN(new Date(s + "T00:00:00Z").getTime());
}

type FieldResult<T> = { ok: true; value: T } | { ok: false; reason: string };

// Trims (and, for source, lowercases) before comparing rather than
// trusting exact equality — see the 2026-09-08 postmortem above.
function validateSource(raw: unknown): FieldResult<string> {
  if (typeof raw !== "string") {
    return { ok: false, reason: `"source" must be a string; received ${typeof raw} (${preview(raw)}).` };
  }
  const trimmed = raw.trim();
  const normalized = trimmed.toLowerCase();
  if (!ALLOWED_SOURCES.includes(normalized)) {
    return {
      ok: false,
      reason: `"source" must be one of: ${ALLOWED_SOURCES.join(", ")}. Received ${preview(raw)}` +
        (trimmed !== raw ? " (has leading/trailing whitespace)" : "") + ".",
    };
  }
  return { ok: true, value: normalized };
}

function validateDaysArray(raw: unknown): FieldResult<unknown[]> {
  if (!Array.isArray(raw)) {
    return { ok: false, reason: `"days" must be an array; received ${typeof raw} (${preview(raw)}).` };
  }
  if (raw.length === 0) {
    return { ok: false, reason: '"days" must be a non-empty array.' };
  }
  if (raw.length > MAX_DAYS) {
    return { ok: false, reason: `"days" cannot exceed ${MAX_DAYS} entries; received ${raw.length}.` };
  }
  return { ok: true, value: raw };
}

function validateDayEntry(
  entry: unknown,
  index: number,
): FieldResult<{ day: string; data: Record<string, unknown> }> {
  if (!isPlainObject(entry)) {
    return {
      ok: false,
      reason: `days[${index}] must be an object; received ${typeof entry} (${preview(entry)}).`,
    };
  }
  const rawDay = entry.day;
  if (typeof rawDay !== "string") {
    return {
      ok: false,
      reason: `days[${index}].day must be a string (YYYY-MM-DD); received ${typeof rawDay} (${preview(rawDay)}).`,
    };
  }
  const trimmedDay = rawDay.trim();
  if (!isValidDay(trimmedDay)) {
    return {
      ok: false,
      reason: `days[${index}].day is not a valid date (YYYY-MM-DD); received ${preview(rawDay)}.`,
    };
  }
  const { day: _day, ...data } = entry;
  return { ok: true, value: { day: trimmedDay, data } };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }
  if (req.method !== "POST") {
    return json({ ok: false, error: "Method not allowed. Use POST." }, 405);
  }

  const authHeader = req.headers.get("Authorization") || "";
  const bearerMatch = /^Bearer\s+(.+)$/i.exec(authHeader);
  const presentedToken = bearerMatch?.[1]?.trim();
  if (!presentedToken) {
    return json({ ok: false, error: "Missing bearer token." }, 401);
  }

  const declaredLength = Number(req.headers.get("Content-Length") || "0");
  if (declaredLength > MAX_BODY_BYTES) {
    return json({ ok: false, error: "Request body too large." }, 400);
  }
  // Deliberately no Content-Type check here: Shortcuts' "Get Contents of
  // URL" action sends "application/json" without a charset suffix, but
  // has also been seen to omit or vary the header entirely depending on
  // how the request body was built. The body is read as raw text and
  // parsed as JSON regardless of what Content-Type (if any) claims.
  const rawBody = await req.text();
  if (new TextEncoder().encode(rawBody).byteLength > MAX_BODY_BYTES) {
    return json({ ok: false, error: "Request body too large." }, 400);
  }

  let body: unknown;
  try {
    body = JSON.parse(rawBody);
  } catch {
    // Previewing the raw text (not just "invalid JSON") surfaces a BOM or
    // stray character immediately instead of a guessing game — ﻿ at
    // the front is the classic case.
    return json({ ok: false, error: `Body is not valid JSON. Received: ${preview(rawBody)}` }, 400);
  }
  if (!isPlainObject(body)) {
    return json(
      { ok: false, error: `Body must be a JSON object; received ${typeof body} (${preview(body)}).` },
      400,
    );
  }

  // Debug mode: echoes the parsed body and a per-field validation report
  // back to the SAME caller that sent it, so a shape mismatch (wrong
  // nesting, stray whitespace, wrong type) is diagnosable from the
  // Shortcut itself without redeploying or reading server logs. Never
  // written to console — the response is the only place this appears.
  // Still requires a bearer token be present (checked above) so this
  // isn't a fully open endpoint, but does not require it to be valid,
  // since the payload shape is often exactly what's in question when
  // nothing else about the request is trusted yet.
  if (body.debug === true) {
    const sourceResult = validateSource(body.source);
    const daysResult = validateDaysArray(body.days);
    const dayEntries = daysResult.ok
      ? daysResult.value.map((entry, i) => {
        const r = validateDayEntry(entry, i);
        return r.ok
          ? { index: i, valid: true, day: r.value.day, dataKeys: Object.keys(r.value.data) }
          : { index: i, valid: false, reason: r.reason };
      })
      : [];
    return json({
      debug: true,
      contentType: req.headers.get("Content-Type"),
      bodyType: typeof body,
      bodyKeys: Object.keys(body),
      receivedBody: body,
      validation: {
        source: sourceResult.ok
          ? { valid: true, receivedType: typeof body.source, normalized: sourceResult.value }
          : { valid: false, receivedType: typeof body.source, received: body.source, reason: sourceResult.reason },
        days: daysResult.ok
          ? { valid: true, count: daysResult.value.length, entries: dayEntries }
          : { valid: false, receivedType: typeof body.days, reason: daysResult.reason },
      },
    });
  }

  const sourceResult = validateSource(body.source);
  if (!sourceResult.ok) {
    console.log("ingest: rejected — invalid source, keys:", Object.keys(body));
    return json({ ok: false, error: sourceResult.reason }, 400);
  }
  const source = sourceResult.value;

  const daysResult = validateDaysArray(body.days);
  if (!daysResult.ok) {
    console.log("ingest: rejected — invalid days, keys:", Object.keys(body));
    return json({ ok: false, error: daysResult.reason }, 400);
  }

  const validatedDays: { day: string; data: Record<string, unknown> }[] = [];
  for (let i = 0; i < daysResult.value.length; i++) {
    const r = validateDayEntry(daysResult.value[i], i);
    if (!r.ok) {
      console.log("ingest: rejected — invalid day entry at index", i);
      return json({ ok: false, error: r.reason }, 400);
    }
    validatedDays.push(r.value);
  }

  const admin = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { persistSession: false } },
  );

  const presentedHash = await sha256Hex(presentedToken);

  // Fetched and compared in application code, not narrowed by an SQL
  // WHERE token_hash = ..., specifically so the match itself runs at a
  // constant time independent of which row (if any) it is.
  const { data: candidates, error: lookupError } = await admin
    .from("device_tokens")
    .select("id,user_id,token_hash")
    .is("revoked_at", null);
  if (lookupError) {
    console.error("ingest: device_tokens lookup failed");
    return json({ ok: false, error: "Internal error." }, 500);
  }

  let matched: { id: string; user_id: string } | null = null;
  for (const row of candidates ?? []) {
    if (timingSafeEqualHex(row.token_hash as string, presentedHash)) {
      matched = { id: row.id as string, user_id: row.user_id as string };
    }
  }
  if (!matched) {
    console.log("ingest: rejected — unknown or revoked token");
    return json({ ok: false, error: "Invalid or revoked token." }, 401);
  }

  const nowIso = new Date().toISOString();
  const rows = validatedDays.map(({ day, data }) => ({
    user_id: matched!.user_id,
    day,
    source,
    data,
    updated_at: nowIso,
  }));

  const { error: upsertError } = await admin
    .from("metrics")
    .upsert(rows, { onConflict: "user_id,day,source" });
  if (upsertError) {
    console.error("ingest: metrics upsert failed, rows:", rows.length);
    return json({ ok: false, error: "Could not write metrics." }, 500);
  }

  const { error: touchError } = await admin
    .from("device_tokens")
    .update({ last_used: nowIso })
    .eq("id", matched.id);
  if (touchError) {
    // Not fatal — the metrics write already succeeded.
    console.error("ingest: last_used update failed");
  }

  console.log("ingest: wrote", rows.length, "day(s), source:", source);
  return json({ ok: true, written: rows.length });
});
