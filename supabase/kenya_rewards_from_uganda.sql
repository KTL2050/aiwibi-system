-- supabase/kenya_rewards_from_uganda.sql
--
-- ONE-TIME COPY: give Kenya the same rewards as Uganda.
-- Run in Supabase (lumio project) → SQL Editor.
--
--   · Tiers:  Kenya's tiers are replaced by an exact copy of Uganda's.
--   · Gifts:  Kenya's gift list is replaced by a copy of Uganda's active gifts
--             (title, points, photo, …). The photo files are shared, not copied.
--   · Kenya gifts that a mother has already redeemed are hidden (is_active =
--     false), not deleted, so her redemption history stays intact.
--
-- After this, each country is edited separately in Settings as before.
-- Points (100 per link) are already the same in both countries.
--
-- Run STEP 1 first (read-only) and check the numbers. Then run STEP 2.
-- STEP 2 runs as one transaction: if any part fails, nothing changes.


-- ─── STEP 1: preview (read-only) ─────────────────────────────────────────
select 'tiers'   as what, country, count(*) from public.tiers   group by country
union all
select 'gifts (active)', country, count(*) from public.rewards where is_active group by country
union all
select 'gifts (hidden)', country, count(*) from public.rewards where not is_active group by country
order by 1, 2;

-- Kenya gifts that have redemptions (these get hidden, not deleted):
select r.title, count(rr.*) as redemptions
from public.rewards r
join public.reward_redemptions rr on rr.reward_id = r.id
where r.country = 'kenya'
group by r.title;


-- ─── STEP 2: copy Uganda → Kenya ─────────────────────────────────────────
begin;

-- Tiers: replace Kenya's with Uganda's.
delete from public.tiers where country = 'kenya';
insert into public.tiers
select (jsonb_populate_record(null::public.tiers, to_jsonb(t) || '{"country":"kenya"}')).*
from public.tiers t
where t.country = 'uganda';

-- Gifts: hide Kenya gifts with redemptions, delete the rest.
update public.rewards r set is_active = false
where r.country = 'kenya'
  and exists (select 1 from public.reward_redemptions rr where rr.reward_id = r.id);

delete from public.rewards r
where r.country = 'kenya'
  and not exists (select 1 from public.reward_redemptions rr where rr.reward_id = r.id);

-- Copy Uganda's active gifts. Every column is copied except id and
-- created_at (new ones are generated) and country (set to kenya).
do $$
declare cols text;
begin
  select string_agg(quote_ident(column_name), ', ' order by ordinal_position)
    into cols
  from information_schema.columns
  where table_schema = 'public' and table_name = 'rewards'
    and column_name not in ('id', 'created_at', 'country');

  execute format(
    'insert into public.rewards (%1$s, country)
     select %1$s, ''kenya'' from public.rewards
     where country = ''uganda'' and is_active',
    cols);
end $$;

commit;


-- ─── STEP 3: check (read-only) ───────────────────────────────────────────
-- Both countries should now show the same active gift and tier counts.
select 'tiers'   as what, country, count(*) from public.tiers   group by country
union all
select 'gifts (active)', country, count(*) from public.rewards where is_active group by country
order by 1, 2;
