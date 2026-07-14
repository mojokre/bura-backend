-- Forced interstitial after a finished match. Survies refresh / other browsers.

alter table public.profiles
  add column if not exists pending_ad_after_match boolean not null default false;

create index if not exists profiles_pending_ad_idx
  on public.profiles (pending_ad_after_match)
  where pending_ad_after_match = true;
