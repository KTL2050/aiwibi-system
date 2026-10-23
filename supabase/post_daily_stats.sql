-- ═══════════════════════════════════════════════════════════════════════════
-- Aiwibi / lumio — daily snapshots of every video's numbers
--
-- One row per video per day (views, likes, comments, shares as PostPeer
-- reported them that day). Written only by the daily-snapshot edge function.
-- Comparing two days gives what a video GAINED in between — the basis for
-- "views this week", growth charts and weekly leaderboards.
--
-- Run once in Supabase (lumio project) → SQL Editor. Safe to re-run.
-- ═══════════════════════════════════════════════════════════════════════════

begin;

create table if not exists public.post_daily_stats (
  snapshot_date date        not null,          -- the day (UTC) the numbers are for
  platform      text        not null,          -- 'tiktok' | 'instagram'
  post_id       text        not null,          -- TikTok video number / Instagram code
  user_id       uuid        references auth.users(id) on delete cascade,
  account_id    text,                          -- PostPeer account the post belongs to
  url           text,
  views         bigint,                        -- null = platform didn't report it (Instagram often)
  likes         bigint,
  comments      bigint,
  shares        bigint,
  published_at  timestamptz,
  captured_at   timestamptz not null default now(),
  primary key (snapshot_date, platform, post_id)
);

create index if not exists post_daily_stats_user_date_idx on public.post_daily_stats (user_id, snapshot_date);
create index if not exists post_daily_stats_date_idx      on public.post_daily_stats (snapshot_date);

alter table public.post_daily_stats enable row level security;

-- Read: a mother sees her own videos; an admin sees their country's mothers;
-- the superadmin sees everything. Nobody writes from the browser.
drop policy if exists "Read own or own-country daily stats" on public.post_daily_stats;
create policy "Read own or own-country daily stats"
  on public.post_daily_stats for select to authenticated
  using (user_id = auth.uid()
         or (public.is_admin() and public.can_manage_country(public.country_of(user_id))));

revoke insert, update, delete on public.post_daily_stats from anon, authenticated;
grant select on public.post_daily_stats to authenticated;

commit;
