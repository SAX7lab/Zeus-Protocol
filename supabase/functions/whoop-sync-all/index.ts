// ZEUS Protocol — Whoop data sync, every connected account (ROADMAP.md 5.3).
//
// The scheduled counterpart to whoop-sync: no user session exists in a
// cron job, so this authenticates the CALLER (not a per-user JWT) by
// requiring the service-role key itself as the bearer token, compared
// constant-time. Whoever holds that key already has full database
// access regardless of this function, so this adds no new exposure —
// it just means only the GitHub Actions workflow that has it as a
// secret (whoop-sync.yml, same pattern as keep-alive.yml) can trigger a
// sync for every user at once. verify_jwt is off (supabase/config.toml)
// since there is no Supabase JWT involved in this path at all.
//
// Iterates whoop_tokens sequentially (not in parallel) — deliberately
// gentle on Whoop's per-account rate limit, and there's no user waiting
// on this response the way there is for whoop-sync's "Sync now" button.
// One user's failure (e.g. a revoked connection) doesn't stop the rest.
//
// Never logs a token, a code, or a client secret. Only counts/outcomes.

import { createClient } from "@supabase/supabase-js";
import { syncWhoopUser, timingSafeEqual } from "../_shared/whoop.ts";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") {
    return json({ ok: false, error: "Method not allowed. Use POST." }, 405);
  }

  const WHOOP_CLIENT_ID = Deno.env.get("WHOOP_CLIENT_ID");
  const WHOOP_CLIENT_SECRET = Deno.env.get("WHOOP_CLIENT_SECRET");
  const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
  const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  if (!WHOOP_CLIENT_ID || !WHOOP_CLIENT_SECRET) {
    console.error("whoop-sync-all: WHOOP_CLIENT_ID/WHOOP_CLIENT_SECRET not configured");
    return json({ ok: false, error: "Server is not configured for Whoop yet." }, 500);
  }

  const presented = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  if (!presented || !timingSafeEqual(presented, SUPABASE_SERVICE_ROLE_KEY)) {
    console.log("whoop-sync-all: rejected — bad or missing bearer");
    return json({ ok: false, error: "Unauthorized." }, 401);
  }

  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  });

  const { data: rows, error: listError } = await admin.from("whoop_tokens").select("user_id");
  if (listError) {
    console.error("whoop-sync-all: listing whoop_tokens failed");
    return json({ ok: false, error: "Could not list connected accounts." }, 500);
  }

  let synced = 0, failed = 0, totalWritten = 0;
  for (const row of rows ?? []) {
    const result = await syncWhoopUser(admin, row.user_id, WHOOP_CLIENT_ID, WHOOP_CLIENT_SECRET);
    if (result.ok) {
      synced++;
      totalWritten += result.written;
    } else {
      failed++;
      console.error("whoop-sync-all: sync failed for one account:", result.error);
    }
  }

  console.log("whoop-sync-all: synced", synced, "account(s), failed", failed, ", wrote", totalWritten, "day(s) total");
  return json({ ok: true, accounts: rows?.length ?? 0, synced, failed, written: totalWritten });
});
