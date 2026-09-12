// ZEUS Protocol — Whoop OAuth connect/callback (ROADMAP.md 5.3).
//
// Two GET paths on this one function:
//   ?start=1&access_token=<supabase jwt>   — begin the flow, redirect to Whoop
//   ?code=...&state=...                    — Whoop's callback, redirect to the app
//
// verify_jwt is off for this function (supabase/config.toml), same
// reasoning as ingest: the callback path is called by Whoop with no
// Supabase session at all, and the start path can't attach a custom
// Authorization header to a plain top-level navigation, so the caller's
// identity is checked by hand in both paths instead — via the access
// token on start, and via the signed state on the callback.
//
// Never logs a token, an authorization code, or a client secret. Only
// counts and outcomes.

import { createClient } from "@supabase/supabase-js";
import {
  WHOOP_AUTH_URL,
  WHOOP_SCOPES,
  signState,
  verifyState,
  exchangeCodeForTokens,
  fetchWhoopUserId,
} from "../_shared/whoop.ts";

const APP_REDIRECT = "https://sax7lab.github.io/Zeus-Protocol/connected.html";
const STATE_MAX_AGE_MS = 10 * 60 * 1000;

function html(body: string, status = 200): Response {
  return new Response(body, { status, headers: { "Content-Type": "text/html; charset=utf-8" } });
}
function errorPage(message: string, status = 400): Response {
  return html(
    `<!doctype html><meta charset="utf-8"><title>Whoop connection failed</title>
    <body style="font-family:-apple-system,sans-serif;background:#060b10;color:#d6e9f2;
      padding:60px 24px;text-align:center;max-width:480px;margin:0 auto">
      <h1 style="font-size:20px">Could not connect Whoop</h1>
      <p style="color:rgba(214,233,242,.7)">${message}</p>
    </body>`,
    status,
  );
}

Deno.serve(async (req: Request) => {
  const url = new URL(req.url);
  const WHOOP_CLIENT_ID = Deno.env.get("WHOOP_CLIENT_ID");
  const WHOOP_CLIENT_SECRET = Deno.env.get("WHOOP_CLIENT_SECRET");
  const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
  const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
  const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

  if (!WHOOP_CLIENT_ID || !WHOOP_CLIENT_SECRET) {
    console.error("whoop-auth: WHOOP_CLIENT_ID/WHOOP_CLIENT_SECRET not configured");
    return errorPage("Server is not configured for Whoop yet.", 500);
  }
  // Must exactly match what is registered with Whoop.
  const redirectUri = `${SUPABASE_URL}/functions/v1/whoop-auth`;

  // ---- path 1: start the flow ----
  if (url.searchParams.get("start") === "1") {
    const accessToken = url.searchParams.get("access_token");
    if (!accessToken) return errorPage("Missing session — open this from the app.", 401);

    const anon = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
    const { data: userData, error: userError } = await anon.auth.getUser(accessToken);
    if (userError || !userData?.user) {
      console.log("whoop-auth: start rejected — invalid or expired session");
      return errorPage("Your session has expired — sign in again and retry.", 401);
    }

    const state = await signState(userData.user.id, WHOOP_CLIENT_SECRET);
    const authorizeUrl = new URL(WHOOP_AUTH_URL);
    authorizeUrl.searchParams.set("response_type", "code");
    authorizeUrl.searchParams.set("client_id", WHOOP_CLIENT_ID);
    authorizeUrl.searchParams.set("redirect_uri", redirectUri);
    authorizeUrl.searchParams.set("scope", WHOOP_SCOPES);
    authorizeUrl.searchParams.set("state", state);

    console.log("whoop-auth: redirecting to Whoop authorize");
    return Response.redirect(authorizeUrl.toString(), 302);
  }

  // ---- path 2: Whoop's callback ----
  const whoopError = url.searchParams.get("error");
  if (whoopError) {
    console.log("whoop-auth: Whoop returned an error:", whoopError);
    return errorPage("Whoop declined the connection.");
  }

  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (code && state) {
    const verified = await verifyState(state, WHOOP_CLIENT_SECRET, STATE_MAX_AGE_MS);
    if (!verified) {
      console.log("whoop-auth: state verification failed (invalid signature or expired)");
      return errorPage("This connection link has expired or is invalid — start again from the app.", 400);
    }

    let tokens;
    try {
      tokens = await exchangeCodeForTokens(code, redirectUri, WHOOP_CLIENT_ID, WHOOP_CLIENT_SECRET);
    } catch {
      console.error("whoop-auth: code exchange failed");
      return errorPage("Could not complete the connection with Whoop. Try again.", 502);
    }

    const whoopUserId = await fetchWhoopUserId(tokens.access_token);
    const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false },
    });
    const { error: upsertError } = await admin.from("whoop_tokens").upsert({
      user_id: verified.userId,
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      expires_at: new Date(Date.now() + tokens.expires_in * 1000).toISOString(),
      whoop_user_id: whoopUserId,
      connected_at: new Date().toISOString(),
    });
    if (upsertError) {
      console.error("whoop-auth: storing tokens failed");
      return errorPage("Connected to Whoop, but could not save the connection. Try again.", 500);
    }

    console.log("whoop-auth: connected user", verified.userId);
    return Response.redirect(APP_REDIRECT, 302);
  }

  // Neither path matched — a plain health check.
  return html("whoop-auth is running. Use ?start=1&access_token=... from the app to connect Whoop.");
});
