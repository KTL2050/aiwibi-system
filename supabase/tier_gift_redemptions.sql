-- supabase/tier_gift_redemptions.sql
--
-- Lets mothers redeem tier gifts (set in Settings → Tiers) from the
-- Available Rewards catalogue. Tier gifts have no row in rewards, so their
-- redemptions carry no reward_id. Run once in Supabase → SQL Editor.
--
-- Existing redemptions are unaffected. The notification triggers only use
-- reward_title and points_cost, so admins are still told about the request.

-- Tier gifts have no row in rewards, so their redemptions carry no reward_id.
alter table public.reward_redemptions alter column reward_id drop not null;
