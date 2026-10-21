-- ═══════════════════════════════════════════════════════════════════════════
-- Aiwibi / lumio — separate Uganda and Kenya
--
-- Run once in Supabase (lumio project, cqtebvfegeojjkrkzboq) → SQL Editor →
-- paste ALL of it → Run. It runs as ONE transaction: if any statement fails,
-- nothing is changed.
--
-- After this:
--   · Mothers see only their own country's gifts, tiers, campaigns and ideas
--     (and, as before, only their own submissions / redemptions).
--   · A country admin sees and edits only their own country's mothers,
--     submissions, social accounts, redemptions and catalog.
--   · The superadmin sees and edits everything.
--   · Existing gifts, tiers, campaigns and ideas become Uganda's.
--     Kenya gets its own Bronze/Silver/Gold rows (copied from Uganda as a
--     starting point — edit them in Settings); its gifts, campaigns and
--     ideas start empty.
--   · Two existing holes are closed:
--       1. a user could change their own `role` (e.g. make themselves admin);
--       2. any signed-in user could change platform settings.
-- ═══════════════════════════════════════════════════════════════════════════

begin;

-- ─── 1. HELPERS: who is asking? ────────────────────────────────────────────
-- SECURITY DEFINER so they can read profiles without tripping profiles' own
-- row-level security (and without recursion).

create or replace function public.app_role()
returns text language sql stable security definer set search_path = public as $$
  select role from public.profiles where id = auth.uid()
$$;

create or replace function public.app_country()
returns text language sql stable security definer set search_path = public as $$
  select country from public.profiles where id = auth.uid()
$$;

-- Superadmin: every country. Admin: only their own country.
create or replace function public.can_manage_country(c text)
returns boolean language sql stable security definer set search_path = public as $$
  select case public.app_role()
           when 'superadmin' then true
           when 'admin'      then c is not distinct from public.app_country()
           else false
         end
$$;

-- Country of any user (for tables that only store user_id).
create or replace function public.country_of(uid uuid)
returns text language sql stable security definer set search_path = public as $$
  select country from public.profiles where id = uid
$$;

revoke execute on function public.app_role()                from public, anon;
revoke execute on function public.app_country()             from public, anon;
revoke execute on function public.can_manage_country(text)  from public, anon;
revoke execute on function public.country_of(uuid)          from public, anon;
grant  execute on function public.app_role()                to authenticated;
grant  execute on function public.app_country()             to authenticated;
grant  execute on function public.can_manage_country(text)  to authenticated;
grant  execute on function public.country_of(uuid)          to authenticated;

-- ─── 2. COUNTRY ON THE CATALOG TABLES (existing rows → uganda) ─────────────
-- Default 'uganda' only so the current live pages keep working until the
-- updated pages (which always send the country) are deployed.

alter table public.rewards         add column if not exists country text;
alter table public.tiers           add column if not exists country text;
alter table public.campaigns       add column if not exists country text;
alter table public.idea_categories add column if not exists country text;
alter table public.idea_videos     add column if not exists country text;

update public.rewards         set country = 'uganda' where country is null;
update public.tiers           set country = 'uganda' where country is null;
update public.campaigns       set country = 'uganda' where country is null;
update public.idea_categories set country = 'uganda' where country is null;
update public.idea_videos     set country = 'uganda' where country is null;

alter table public.rewards         alter column country set default 'uganda', alter column country set not null;
alter table public.tiers           alter column country set default 'uganda', alter column country set not null;
alter table public.campaigns       alter column country set default 'uganda', alter column country set not null;
alter table public.idea_categories alter column country set default 'uganda', alter column country set not null;
alter table public.idea_videos     alter column country set default 'uganda', alter column country set not null;

alter table public.rewards         add constraint rewards_country_check         check (country in ('uganda','kenya'));
alter table public.tiers           add constraint tiers_country_check           check (country in ('uganda','kenya'));
alter table public.campaigns       add constraint campaigns_country_check       check (country in ('uganda','kenya'));
alter table public.idea_categories add constraint idea_categories_country_check check (country in ('uganda','kenya'));
alter table public.idea_videos     add constraint idea_videos_country_check     check (country in ('uganda','kenya'));

-- Tiers: one Bronze/Silver/Gold PER COUNTRY (was one per key overall).
alter table public.tiers drop constraint tiers_pkey;
alter table public.tiers add primary key (country, key);

-- Kenya starts with its own copy of the tiers, to edit in Settings.
insert into public.tiers
select (jsonb_populate_record(null::public.tiers, to_jsonb(t) || '{"country":"kenya"}')).*
from public.tiers t
where t.country = 'uganda'
on conflict do nothing;

create index if not exists rewards_country_idx         on public.rewards (country);
create index if not exists campaigns_country_idx       on public.campaigns (country);
create index if not exists idea_categories_country_idx on public.idea_categories (country);
create index if not exists idea_videos_country_idx     on public.idea_videos (country);

-- ─── 3. PROFILES ───────────────────────────────────────────────────────────
drop policy if exists "Admins can view all profiles" on public.profiles;
create policy "Admins view profiles in their country"
  on public.profiles for select
  using (public.is_admin() and public.can_manage_country(country));

-- Own profile: may edit it, but NOT change their role, and may set their
-- country only once (from empty) — not switch countries afterwards.
drop policy if exists "Users can update their own profile" on public.profiles;
create policy "Users can update their own profile"
  on public.profiles for update
  using (auth.uid() = id)
  with check (
    auth.uid() = id
    and role is not distinct from public.app_role()
    and (public.app_country() is null or country is not distinct from public.app_country())
  );

-- ─── 4. MOTHERS' DATA: admins only within their country ────────────────────
drop policy if exists "Admins can view all submitted content" on public.submitted_content;
create policy "Admins view submitted content in their country"
  on public.submitted_content for select
  using (public.is_admin() and public.can_manage_country(public.country_of(user_id)));

drop policy if exists "Admins can view all social accounts" on public.social_accounts;
create policy "Admins view social accounts in their country"
  on public.social_accounts for select
  using (public.is_admin() and public.can_manage_country(public.country_of(user_id)));

drop policy if exists "Admins can view all redemptions" on public.reward_redemptions;
create policy "Admins view redemptions in their country"
  on public.reward_redemptions for select
  using (public.is_admin() and public.can_manage_country(public.country_of(user_id)));

drop policy if exists "Admins can update redemptions" on public.reward_redemptions;
create policy "Admins update redemptions in their country"
  on public.reward_redemptions for update
  using (public.is_admin() and public.can_manage_country(public.country_of(user_id)))
  with check (public.is_admin() and public.can_manage_country(public.country_of(user_id)));

-- ─── 5. CATALOG: mothers see their country; admins manage their country ────
-- rewards
drop policy if exists "Anyone can view rewards"          on public.rewards;
drop policy if exists "Everyone can view active rewards" on public.rewards;
drop policy if exists "Admins can insert rewards"        on public.rewards;
drop policy if exists "Admins can update rewards"        on public.rewards;
drop policy if exists "Admins can delete rewards"        on public.rewards;
create policy "View rewards of own country"
  on public.rewards for select
  using ((is_active = true and country = public.app_country())
         or (public.is_admin() and public.can_manage_country(country)));
create policy "Admins manage rewards in their country"
  on public.rewards for all to authenticated
  using (public.is_admin() and public.can_manage_country(country))
  with check (public.is_admin() and public.can_manage_country(country));

-- tiers
drop policy if exists "Anyone can view tiers"   on public.tiers;
drop policy if exists "Admins can update tiers" on public.tiers;
create policy "View tiers of own country"
  on public.tiers for select
  using (country = public.app_country()
         or (public.is_admin() and public.can_manage_country(country)));
create policy "Admins manage tiers in their country"
  on public.tiers for all to authenticated
  using (public.is_admin() and public.can_manage_country(country))
  with check (public.is_admin() and public.can_manage_country(country));

-- campaigns
drop policy if exists "Everyone can view published campaigns" on public.campaigns;
drop policy if exists "Admins can insert campaigns"           on public.campaigns;
drop policy if exists "Admins can update campaigns"           on public.campaigns;
drop policy if exists "Admins can delete campaigns"           on public.campaigns;
create policy "View published campaigns of own country"
  on public.campaigns for select
  using ((is_draft = false and country = public.app_country())
         or (public.is_admin() and public.can_manage_country(country)));
create policy "Admins manage campaigns in their country"
  on public.campaigns for all to authenticated
  using (public.is_admin() and public.can_manage_country(country))
  with check (public.is_admin() and public.can_manage_country(country));

-- idea categories
drop policy if exists "admins manage idea categories"       on public.idea_categories;
drop policy if exists "signed-in users read idea categories" on public.idea_categories;
create policy "Read idea categories of own country"
  on public.idea_categories for select to authenticated
  using (country = public.app_country()
         or (public.is_admin() and public.can_manage_country(country)));
create policy "Admins manage idea categories in their country"
  on public.idea_categories for all to authenticated
  using (public.is_admin() and public.can_manage_country(country))
  with check (public.is_admin() and public.can_manage_country(country));

-- idea videos
drop policy if exists "admins manage idea videos"       on public.idea_videos;
drop policy if exists "signed-in users read idea videos" on public.idea_videos;
create policy "Read idea videos of own country"
  on public.idea_videos for select to authenticated
  using (country = public.app_country()
         or (public.is_admin() and public.can_manage_country(country)));
create policy "Admins manage idea videos in their country"
  on public.idea_videos for all to authenticated
  using (public.is_admin() and public.can_manage_country(country))
  with check (public.is_admin() and public.can_manage_country(country));

-- ─── 6. PLATFORM SETTINGS: only the superadmin may change them ─────────────
drop policy if exists "Authenticated can update platform settings" on public.platform_settings;
create policy "Superadmin manages platform settings"
  on public.platform_settings for all to authenticated
  using (public.app_role() = 'superadmin')
  with check (public.app_role() = 'superadmin');

commit;

-- ─── AFTER RUNNING: quick read-only checks ─────────────────────────────────
-- select country, count(*) from rewards group by 1;          -- all 'uganda'
-- select country, key from tiers order by 1, 2;              -- uganda + kenya rows
-- select tablename, policyname, cmd from pg_policies
--  where schemaname = 'public'
--    and tablename in ('profiles','submitted_content','social_accounts','reward_redemptions',
--                      'rewards','tiers','campaigns','idea_categories','idea_videos','platform_settings')
--  order by 1, 2;
