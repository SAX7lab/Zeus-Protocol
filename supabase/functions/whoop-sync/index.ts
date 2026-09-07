// ZEUS Protocol — Whoop data sync, one user (ROADMAP.md 5.3).
//
// Called by the client via supabase-js's functions.invoke('whoop-sync'),
// which attaches the caller's real Supabase session automatically —
// unlike whoop-auth/ingest, this needs no custom auth scheme, hence
// verify_jwt = true (supabase/config.toml). Still resolves the caller's
// own user id via auth.getUser() rather than trusting a decoded JWT
// payload directly.
//
// The actual sync (fetch, day-bucketing, upsert) lives in
// syncWhoopUser() in _shared/whoop.ts, shared with whoop-sync-all — the
// scheduled version of this same sync, run twice daily for every
// connected account rather than on demand for one.
//
// Never logs a token, a code, or a client secret. Only counts/outcomes.

import { createClient } from "@supabase/supabase-js";
import { syncWhoopUser } from "../_shared/whoop.ts";

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

  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  });

  const result = await syncWhoopUser(admin, userData.user.id, WHOOP_CLIENT_ID, WHOOP_CLIENT_SECRET);
  if (!result.ok) {
    console.error("whoop-sync: sync failed:", result.error);
    return json(result, result.error === "Whoop is not connected." ? 409 : 502);
  }
  console.log("whoop-sync: wrote", result.written, "day(s)");
  return json(result);
});
