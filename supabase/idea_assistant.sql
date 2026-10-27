-- supabase/idea_assistant.sql
--
-- Idea Assistant (mother page "Idea Assistant").
--
--   idea_trend_briefs — the weekly "what's working in baby / diaper videos"
--                       summary per country, written by the idea-trends
--                       function (Claude + web search). Server-only.
--   idea_scripts      — one row per conversation a mother starts: the chat and,
--                       once finished, the script. Also how the 3-per-day limit
--                       is counted. A mother can read her own; only the
--                       idea-assistant function (secret key) writes, so the
--                       limit can't be bypassed from the browser.
--
-- Safe to run more than once.

create table if not exists public.idea_trend_briefs (
  id          bigserial primary key,
  country     text not null check (country in ('uganda', 'kenya')),
  brief       text not null,
  sources     jsonb not null default '[]'::jsonb,
  created_at  timestamptz not null default now()
);
create index if not exists idea_trend_briefs_country_created
  on public.idea_trend_briefs (country, created_at desc);

alter table public.idea_trend_briefs enable row level security;
-- No policies: only the edge functions (secret key) read or write it.

create table if not exists public.idea_scripts (
  id            bigserial primary key,
  user_id       uuid not null references auth.users (id) on delete cascade,
  country       text,
  messages      jsonb not null default '[]'::jsonb,
  script        jsonb,
  status        text not null default 'chatting' check (status in ('chatting', 'done')),
  created_at    timestamptz not null default now(),
  completed_at  timestamptz
);
create index if not exists idea_scripts_user_created
  on public.idea_scripts (user_id, created_at desc);

alter table public.idea_scripts enable row level security;

drop policy if exists "Mothers read their own idea scripts" on public.idea_scripts;
create policy "Mothers read their own idea scripts"
  on public.idea_scripts for select
  to authenticated
  using (user_id = auth.uid());
-- No insert/update/delete policies: the idea-assistant function does those.
