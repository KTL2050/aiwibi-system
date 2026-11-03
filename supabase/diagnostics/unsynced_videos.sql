-- supabase/diagnostics/unsynced_videos.sql
--
-- READ-ONLY. Changes nothing. Run in Supabase (lumio project) → SQL Editor.
--
-- Why do some submitted videos have no statistics? For every mother's
-- submitted video, this works out the most likely reason, using the same
-- data the dashboards use:
--   · submitted_content + resolved_urls   (what she submitted, short links expanded)
--   · social_accounts                     (which accounts she has connected)
--   · analytics_cache  account:<id>:latest (the latest posts PostPeer returned for her)
--   · post_daily_stats                    (every video's numbers, saved nightly)
--
-- Query 1 = summary per mother (find the one with e.g. 17 of 28 synced).
-- Query 2 = every video without stats, with its reason.
-- Run them one at a time (select the query, then Run).

-- ─── Query 1: summary per mother ─────────────────────────────────────────
with subs as (
  select distinct on (s.user_id, coalesce(r.resolved_url, s.video_url))
    s.user_id, s.platform, s.video_url, s.submitted_at,
    coalesce(r.resolved_url, s.video_url) as full_url
  from submitted_content s
  left join resolved_urls r on r.raw_url = s.video_url
),
ids as (
  select subs.*,
    case when full_url ~* 'tiktok'
         then substring(full_url from '/(?:video|photo)/([0-9]+)')
         else substring(full_url from '/(?:p|reels?|tv)/([A-Za-z0-9_-]+)') end as post_id
  from subs
),
acct as (
  select sa.user_id, sa.platform, c.payload
  from social_accounts sa
  left join analytics_cache c on c.cache_key = 'account:' || sa.postpeer_account_id || ':latest'
),
window_posts as (
  select a.user_id, a.platform,
    case when p->'platforms'->0->>'platformPostUrl' ~* 'tiktok'
         then substring(p->'platforms'->0->>'platformPostUrl' from '/(?:video|photo)/([0-9]+)')
         else substring(p->'platforms'->0->>'platformPostUrl' from '/(?:p|reels?|tv)/([A-Za-z0-9_-]+)') end as post_id,
    (p->>'publishedAt')::timestamptz as published_at
  from acct a, jsonb_array_elements(coalesce(a.payload->'posts', '[]'::jsonb)) p
),
window_stats as (
  select user_id, platform, count(*) as n, min(published_at) as oldest
  from window_posts group by 1, 2
),
snap as (select distinct platform, post_id from post_daily_stats),
classified as (
  select i.*,
    case
      when i.post_id is null
        then '1 Link not recognised (no video ID in it)'
      when exists (select 1 from window_posts w where w.post_id = i.post_id and w.user_id = i.user_id)
        then '0 Has stats'
      when exists (select 1 from window_posts w where w.post_id = i.post_id)
        then '2 Video is from another mother''s connected account'
      when not exists (select 1 from acct a where a.user_id = i.user_id and a.platform = i.platform)
        then '3 Her ' || i.platform || ' account is not connected'
      when not exists (select 1 from acct a where a.user_id = i.user_id and a.platform = i.platform and a.payload is not null)
        then '4 Account connected, but PostPeer has returned no data for it'
      when exists (select 1 from snap s where s.post_id = i.post_id)
        then '5 Had stats before; now older than the 50 latest posts PostPeer returns'
      when ws.n >= 50 and i.platform = 'tiktok'
           and to_timestamp(floor(i.post_id::numeric / 4294967296)) < ws.oldest
        then '6 Older than her 50 latest posts (never captured)'
      when ws.n >= 50
        then '7 Probably older than her 50 latest posts'
      else '8 Not in her account: another account''s video, deleted or private'
    end as reason
  from ids i
  left join window_stats ws on ws.user_id = i.user_id and ws.platform = i.platform
)
select p.full_name as mother, p.country,
  count(*)                                         as videos,
  count(*) filter (where c.reason like '0%')       as with_stats,
  count(*) filter (where c.reason like '1%')       as link_not_recognised,
  count(*) filter (where c.reason like '2%')       as other_mothers_account,
  count(*) filter (where c.reason like '3%')       as account_not_connected,
  count(*) filter (where c.reason like '4%')       as postpeer_no_data,
  count(*) filter (where c.reason like '5%' or c.reason like '6%' or c.reason like '7%') as too_old_for_window,
  count(*) filter (where c.reason like '8%')       as not_in_her_account
from classified c
join profiles p on p.id = c.user_id
where p.role = 'mother'
group by p.full_name, p.country
order by videos desc;


-- ─── Query 2: every video without stats, with its reason ─────────────────
with subs as (
  select distinct on (s.user_id, coalesce(r.resolved_url, s.video_url))
    s.user_id, s.platform, s.video_url, s.submitted_at,
    coalesce(r.resolved_url, s.video_url) as full_url
  from submitted_content s
  left join resolved_urls r on r.raw_url = s.video_url
),
ids as (
  select subs.*,
    case when full_url ~* 'tiktok'
         then substring(full_url from '/(?:video|photo)/([0-9]+)')
         else substring(full_url from '/(?:p|reels?|tv)/([A-Za-z0-9_-]+)') end as post_id
  from subs
),
acct as (
  select sa.user_id, sa.platform, c.payload
  from social_accounts sa
  left join analytics_cache c on c.cache_key = 'account:' || sa.postpeer_account_id || ':latest'
),
window_posts as (
  select a.user_id, a.platform,
    case when p->'platforms'->0->>'platformPostUrl' ~* 'tiktok'
         then substring(p->'platforms'->0->>'platformPostUrl' from '/(?:video|photo)/([0-9]+)')
         else substring(p->'platforms'->0->>'platformPostUrl' from '/(?:p|reels?|tv)/([A-Za-z0-9_-]+)') end as post_id,
    (p->>'publishedAt')::timestamptz as published_at
  from acct a, jsonb_array_elements(coalesce(a.payload->'posts', '[]'::jsonb)) p
),
window_stats as (
  select user_id, platform, count(*) as n, min(published_at) as oldest
  from window_posts group by 1, 2
),
snap as (select distinct platform, post_id from post_daily_stats),
classified as (
  select i.*,
    case
      when i.post_id is null
        then '1 Link not recognised (no video ID in it)'
      when exists (select 1 from window_posts w where w.post_id = i.post_id and w.user_id = i.user_id)
        then '0 Has stats'
      when exists (select 1 from window_posts w where w.post_id = i.post_id)
        then '2 Video is from another mother''s connected account'
      when not exists (select 1 from acct a where a.user_id = i.user_id and a.platform = i.platform)
        then '3 Her ' || i.platform || ' account is not connected'
      when not exists (select 1 from acct a where a.user_id = i.user_id and a.platform = i.platform and a.payload is not null)
        then '4 Account connected, but PostPeer has returned no data for it'
      when exists (select 1 from snap s where s.post_id = i.post_id)
        then '5 Had stats before; now older than the 50 latest posts PostPeer returns'
      when ws.n >= 50 and i.platform = 'tiktok'
           and to_timestamp(floor(i.post_id::numeric / 4294967296)) < ws.oldest
        then '6 Older than her 50 latest posts (never captured)'
      when ws.n >= 50
        then '7 Probably older than her 50 latest posts'
      else '8 Not in her account: another account''s video, deleted or private'
    end as reason
  from ids i
  left join window_stats ws on ws.user_id = i.user_id and ws.platform = i.platform
)
select p.full_name as mother, c.platform, c.submitted_at::date as submitted, c.reason, c.video_url
from classified c
join profiles p on p.id = c.user_id
where p.role = 'mother' and c.reason not like '0%'
order by p.full_name, c.reason, c.submitted_at;
