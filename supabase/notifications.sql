-- ═══════════════════════════════════════════════════════════════════════════
-- Aiwibi / lumio — in-app notifications (the bell)
--
-- Run once in Supabase → SQL Editor → paste → Run.
-- Safe to run again: everything is "create or replace" / "if not exists".
--
-- Notifications are only ever created by the triggers below (running as the
-- database owner). Browsers can read their own rows and mark them read —
-- nothing else.
--
-- If a trigger fails for any reason it only logs a warning; it never blocks
-- the redemption / submission / reward that fired it.
-- ═══════════════════════════════════════════════════════════════════════════

-- ─── 1. TABLE ──────────────────────────────────────────────────────────────
create table if not exists public.notifications (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  kind        text not null,          -- e.g. reward_delivered, new_reward
  title       text not null,
  body        text,
  link        text,                   -- page to open when clicked
  read_at     timestamptz,            -- null = unread
  created_at  timestamptz not null default now()
);

create index if not exists notifications_user_created_idx
  on public.notifications (user_id, created_at desc);

-- ─── 2. SECURITY ───────────────────────────────────────────────────────────
alter table public.notifications enable row level security;

drop policy if exists "notifications: read own" on public.notifications;
create policy "notifications: read own"
  on public.notifications for select
  using (user_id = auth.uid());

drop policy if exists "notifications: mark own read" on public.notifications;
create policy "notifications: mark own read"
  on public.notifications for update
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

-- Browsers may only change read_at — not the title, body, owner, etc.
revoke insert, update, delete on public.notifications from anon, authenticated;
grant select on public.notifications to authenticated;
grant update (read_at) on public.notifications to authenticated;

-- ─── 3. LIVE UPDATES (Supabase Realtime) ───────────────────────────────────
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public' and tablename = 'notifications'
  ) then
    alter publication supabase_realtime add table public.notifications;
  end if;
end $$;

-- ─── 4. HELPER: notify the admins responsible for a country ────────────────
-- Superadmins always; plain admins only for their own country.
create or replace function public.notify_admins(
  p_country text, p_kind text, p_title text, p_body text, p_link text
) returns void
language sql
security definer
set search_path = public
as $$
  insert into public.notifications (user_id, kind, title, body, link)
  select p.id, p_kind, p_title, p_body, p_link
  from public.profiles p
  where p.role = 'superadmin'
     or (p.role = 'admin' and p.country is not distinct from p_country);
$$;

revoke execute on function public.notify_admins(text, text, text, text, text) from public, anon, authenticated;

-- ─── 5. MOTHER: reward Delivered / Cancelled ───────────────────────────────
create or replace function public.trg_notify_redemption_status()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.status is distinct from old.status then
    if new.status = 'Delivered' then
      insert into public.notifications (user_id, kind, title, body, link)
      values (new.user_id, 'reward_delivered',
              'Your reward has been delivered 🎉',
              coalesce(new.reward_title, 'Your reward') || ' is on its way to you.',
              'motherreward.html');
    elsif new.status = 'Cancelled' then
      insert into public.notifications (user_id, kind, title, body, link)
      values (new.user_id, 'reward_cancelled',
              'Reward request cancelled',
              coalesce(new.reward_title, 'Your reward') || ' was cancelled — your '
                || coalesce(new.points_cost, 0) || ' pts have been returned.',
              'motherreward.html');
    end if;
  end if;
  return new;
exception when others then
  raise warning 'notify redemption status failed: %', sqlerrm;
  return new;
end $$;

drop trigger if exists notify_redemption_status on public.reward_redemptions;
create trigger notify_redemption_status
  after update of status on public.reward_redemptions
  for each row execute function public.trg_notify_redemption_status();

-- ─── 6. MOTHERS: new reward in the catalog ─────────────────────────────────
create or replace function public.trg_notify_new_reward()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if coalesce(new.is_active, true) then
    insert into public.notifications (user_id, kind, title, body, link)
    select p.id, 'new_reward',
           'New reward available 🎁',
           coalesce(new.title, 'A new reward') || ' — ' || coalesce(new.points_cost, 0) || ' pts',
           'motherreward.html'
    from public.profiles p
    where p.role = 'mother';
  end if;
  return new;
exception when others then
  raise warning 'notify new reward failed: %', sqlerrm;
  return new;
end $$;

drop trigger if exists notify_new_reward on public.rewards;
create trigger notify_new_reward
  after insert on public.rewards
  for each row execute function public.trg_notify_new_reward();

-- ─── 7. MOTHER: points for a submitted link ────────────────────────────────
create or replace function public.trg_notify_link_points()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.notifications (user_id, kind, title, body, link)
  values (new.user_id, 'link_points',
          '+100 pts earned',
          'Thanks for sharing your '
            || case lower(coalesce(new.platform, ''))
                 when 'tiktok' then 'TikTok'
                 when 'instagram' then 'Instagram'
                 else 'video'
               end
            || ' link.',
          'mothercont.html');
  return new;
exception when others then
  raise warning 'notify link points failed: %', sqlerrm;
  return new;
end $$;

drop trigger if exists notify_link_points on public.submitted_content;
create trigger notify_link_points
  after insert on public.submitted_content
  for each row execute function public.trg_notify_link_points();

-- ─── 8. ADMINS: new redemption request ─────────────────────────────────────
create or replace function public.trg_notify_redemption_request()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_name text;
  v_country text;
begin
  select coalesce(nullif(p.full_name, ''), p.email, 'A mother'), p.country
    into v_name, v_country
  from public.profiles p where p.id = new.user_id;

  perform public.notify_admins(
    v_country, 'redemption_request',
    'New reward request',
    coalesce(v_name, 'A mother') || ' requested ' || coalesce(new.reward_title, 'a reward')
      || ' (' || coalesce(new.points_cost, 0) || ' pts).',
    'adminreward.html');
  return new;
exception when others then
  raise warning 'notify redemption request failed: %', sqlerrm;
  return new;
end $$;

drop trigger if exists notify_redemption_request on public.reward_redemptions;
create trigger notify_redemption_request
  after insert on public.reward_redemptions
  for each row execute function public.trg_notify_redemption_request();

-- ─── 9. ADMINS: new mother joined ──────────────────────────────────────────
-- Fires when a mother picks her country on first login (until then admins
-- can't be matched by country).
create or replace function public.trg_notify_new_mother()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.role = 'mother' and old.country is null and new.country is not null then
    perform public.notify_admins(
      new.country, 'new_mother',
      'New mother joined',
      coalesce(nullif(new.full_name, ''), new.email, 'A new mother') || ' has joined from '
        || initcap(new.country) || '.',
      'admincont.html');
  end if;
  return new;
exception when others then
  raise warning 'notify new mother failed: %', sqlerrm;
  return new;
end $$;

drop trigger if exists notify_new_mother on public.profiles;
create trigger notify_new_mother
  after update of country on public.profiles
  for each row execute function public.trg_notify_new_mother();
