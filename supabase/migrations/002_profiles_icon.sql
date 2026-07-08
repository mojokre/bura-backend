-- Adds profile icon storage path to profiles.

alter table public.profiles
  add column if not exists icon_path text;

-- Helpful index for non-null lookups
create index if not exists profiles_icon_path_idx
  on public.profiles (icon_path);

-- Keep RLS as-is; existing update policy allows updating the row.
-- Clients must NOT be able to insert/update profiles directly.

