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
function timingSafeEqual(a: string, b: string): boolean {
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
// null if this user has no Whoop connection at all. Prepared here for
// the sync function (ROADMAP.md 5.3, next phase) — nothing calls this
// yet.
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
