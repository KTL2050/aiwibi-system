-- ═══════════════════════════════════════════════════════════════════════════
-- Follow-up to country_separation.sql
--
-- Some of the new rules applied to signed-out visitors too. Their checks call
-- helper functions that only signed-in users may run, so a signed-out request
-- got "permission denied for function can_manage_country" instead of simply
-- no rows. Signed-out visitors have no business reading these tables anyway,
-- so these rules now apply to signed-in users only.
--
-- Run once in Supabase (lumio project) → SQL Editor. Safe to re-run.
-- ═══════════════════════════════════════════════════════════════════════════

begin;

alter policy "Admins view profiles in their country"           on public.profiles           to authenticated;
alter policy "Users can update their own profile"              on public.profiles           to authenticated;
alter policy "Admins view submitted content in their country"  on public.submitted_content  to authenticated;
alter policy "Admins view social accounts in their country"    on public.social_accounts    to authenticated;
alter policy "Admins view redemptions in their country"        on public.reward_redemptions to authenticated;
alter policy "Admins update redemptions in their country"      on public.reward_redemptions to authenticated;
alter policy "View rewards of own country"                     on public.rewards            to authenticated;
alter policy "View tiers of own country"                       on public.tiers              to authenticated;
alter policy "View published campaigns of own country"         on public.campaigns          to authenticated;

commit;
