-- ============================================================
-- ZEUS Protocol — Supabase schema
-- Saved in the Supabase SQL Editor as "ZEUS schema".
-- Safe to re-run: create if not exists / drop policy if exists.
-- ============================================================

-- One JSON row per user, mirroring what saveAll() already writes.
-- Biomarker panels are stripped before upload and stay on-device.
create table if not exists app_data (
  user_id    uuid primary key references auth.users on delete cascade,
  payload    jsonb not null,
  updated_at timestamptz not null default now()
);

-- Explicit GDPR consent. `version` lets the prompt reappear when
-- the wording changes.
create table if not exists consents (
  user_id     uuid primary key references auth.users on delete cascade,
  accepted_at timestamptz not null default now(),
  version     text        not null
);

-- Per-user preferences: display name for the header ("Mike's Protocol")
-- and which sections the user wants visible.
create table if not exists profiles (
  user_id      uuid primary key references auth.users on delete cascade,
  display_name text,
  sections     jsonb not null default
    '{"agenda":true,"routine":true,"supps":true,"cal":true,"bio":false}'::jsonb,
  created_at   timestamptz not null default now()
);

-- Keeps the free-tier project awake: free projects pause after 7 days
-- without database activity. A scheduled GitHub Action reads this every
-- few days. Public read is fine — it holds no personal data.
create table if not exists heartbeat (
  id        int primary key,
  pinged_at timestamptz not null default now()
);
insert into heartbeat (id) values (1) on conflict (id) do nothing;

-- Row level security. This is the actual protection: even with a bug in
-- the frontend, Postgres refuses to return another user's row.
alter table app_data  enable row level security;
alter table consents  enable row level security;
alter table profiles  enable row level security;
alter table heartbeat enable row level security;

drop policy if exists "own app_data" on app_data;
create policy "own app_data" on app_data
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "own consent" on consents;
create policy "own consent" on consents
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "own profile" on profiles;
create policy "own profile" on profiles
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "public read heartbeat" on heartbeat;
create policy "public read heartbeat" on heartbeat
  for select using (true);

-- All four tables must come back with rowsecurity = true.
select tablename, rowsecurity
from pg_tables
where schemaname = 'public'
order by tablename;

-- Self-service account deletion (ROADMAP.md 5.2, "Delete account" in
-- index.html). The client only ever holds the anon key, so it can never
-- call the Admin API — that needs the service-role key, which must never
-- reach client code. SECURITY DEFINER runs this with the privileges of
-- whoever creates it (normally the project owner, which can reach
-- auth.users), while the auth.uid() check keeps it strictly self-service:
-- there is no argument to pass, so nobody can target another user's row.
-- app_data, consents and profiles all reference auth.users with
-- `on delete cascade`, so deleting the user row clears all three.
create or replace function delete_own_account()
returns void
language plpgsql
security definer
set search_path = public, auth
as $$
begin
  delete from auth.users where id = auth.uid();
end;
$$;

revoke all on function delete_own_account() from public;
grant execute on function delete_own_account() to authenticated;

-- ============================================================
-- Metrics + device tokens (ROADMAP.md 5.3) — Apple Health and Whoop
-- integrations.
-- ============================================================

-- ---------------------------------------------------------------
-- One row per user, day and source. Apple Health supplies workouts
-- and steps; Whoop supplies sleep and recovery. Keeping them in one
-- table means the app reads a single shape regardless of origin.
-- `data` stays jsonb so a source can add fields without a migration.
-- ---------------------------------------------------------------
create table if not exists metrics (
  user_id    uuid        not null references auth.users on delete cascade,
  day        date        not null,
  source     text        not null check (source in ('apple_health','whoop')),
  data       jsonb       not null,
  updated_at timestamptz not null default now(),
  primary key (user_id, day, source)
);

create index if not exists metrics_user_day_idx on metrics (user_id, day desc);

-- ---------------------------------------------------------------
-- Long-lived tokens for the Apple Shortcut.
--
-- Why not the normal session token: a Supabase access token expires
-- after about an hour, so a daily automation would break overnight.
-- The app mints one of these instead, the user pastes it into the
-- Shortcut once, and an Edge Function exchanges it for a user_id.
--
-- Only the hash is stored. The plaintext is shown once at creation
-- and never again — a leaked table must not yield working tokens.
-- ---------------------------------------------------------------
create table if not exists device_tokens (
  id         uuid        primary key default gen_random_uuid(),
  user_id    uuid        not null references auth.users on delete cascade,
  token_hash text        not null unique,
  label      text,
  created_at timestamptz not null default now(),
  last_used  timestamptz,
  revoked_at timestamptz
);

create index if not exists device_tokens_user_idx on device_tokens (user_id);

-- ---------------------------------------------------------------
-- Row level security. The Edge Function writes with the service
-- role and bypasses these; they govern what the app itself may see.
-- ---------------------------------------------------------------
alter table metrics       enable row level security;
alter table device_tokens enable row level security;

drop policy if exists "own metrics" on metrics;
create policy "own metrics" on metrics
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- The app may list and revoke its own tokens, but never read a hash
-- back out — that column is excluded at the query layer in the client.
drop policy if exists "own device tokens" on device_tokens;
create policy "own device tokens" on device_tokens
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- ---------------------------------------------------------------
-- Both tables should report rowsecurity = true.
-- ---------------------------------------------------------------
select tablename, rowsecurity
from pg_tables
where schemaname = 'public' and tablename in ('metrics','device_tokens');

-- ============================================================
-- Whoop OAuth tokens (ROADMAP.md 5.3). Written only by the whoop-auth
-- Edge Function (service role) — see supabase/functions/whoop-auth.
-- ============================================================

-- One row per user. access_token/refresh_token are live Whoop API
-- credentials. RLS below only scopes ROWS to their owner, same as every
-- other table here — Postgres RLS cannot hide individual COLUMNS, so the
-- app must never select access_token or refresh_token, only connection
-- status (e.g. `connected_at is not null`). That is enforced at the
-- query layer in the client, not by anything in this schema: never add
-- a `select('access_token')` (or `select('*')`) against this table from
-- index.html.
create table if not exists whoop_tokens (
  user_id       uuid        primary key references auth.users on delete cascade,
  access_token  text        not null,
  refresh_token text        not null,
  expires_at    timestamptz not null,
  whoop_user_id text,
  connected_at  timestamptz not null default now(),
  last_sync     timestamptz
);

alter table whoop_tokens enable row level security;

drop policy if exists "own whoop tokens" on whoop_tokens;
create policy "own whoop tokens" on whoop_tokens
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

select tablename, rowsecurity
from pg_tables
where schemaname = 'public' and tablename = 'whoop_tokens';
