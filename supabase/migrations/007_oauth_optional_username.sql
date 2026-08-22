-- OAuth users: username chosen later on profile setup
alter table public.profiles
  alter column username drop not null;

alter table public.profiles
  add column if not exists display_name text,
  add column if not exists auth_provider text not null default 'password',
  add column if not exists username_set_at timestamptz;

alter table public.profiles
  drop constraint if exists profiles_username_unique;

create unique index if not exists profiles_username_unique_idx
  on public.profiles (username)
  where username is not null;

alter table public.profiles
  drop constraint if exists profiles_username_format;

alter table public.profiles
  add constraint profiles_username_format check (
    username is null
    or (
      char_length(username) between 3 and 24
      and username ~ '^[a-zA-Z0-9_]+$'
    )
  );
