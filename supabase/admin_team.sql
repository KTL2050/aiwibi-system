-- ═══════════════════════════════════════════════════════════════════════════
-- Aiwibi / lumio — every new account starts as a mother
--
-- Mothers sign up from the browser, which sends their details along with the
-- signup. Whatever is sent, a NEW profile is always created as a 'mother';
-- only the superadmin (Settings → Team, via the manage-admins function) can
-- turn an account into an admin afterwards. Users already cannot change
-- their own role (country_separation.sql), so this closes the last gap:
-- signing up as an admin to begin with.
--
-- Existing accounts are not touched.
-- Run once in Supabase (lumio project) → SQL Editor. Safe to re-run.
-- ═══════════════════════════════════════════════════════════════════════════

begin;

create or replace function public.force_new_profile_mother()
returns trigger language plpgsql as $$
begin
  new.role := 'mother';
  return new;
end $$;

drop trigger if exists force_new_profile_mother on public.profiles;
create trigger force_new_profile_mother
  before insert on public.profiles
  for each row execute function public.force_new_profile_mother();

commit;
