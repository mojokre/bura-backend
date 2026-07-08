-- Run this in Supabase SQL Editor (Dashboard → SQL → New query)

create extension if not exists citext;

create table if not exists public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  username citext not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint profiles_username_length check (char_length(username) between 3 and 24),
  constraint profiles_username_format check (username ~ '^[a-zA-Z0-9_]+$'),
  constraint profiles_username_unique unique (username)
);

create index if not exists profiles_username_idx on public.profiles (username);

alter table public.profiles enable row level security;

create policy "Public profiles are viewable by everyone"
  on public.profiles
  for select
  using (true);

create policy "Users can update own profile"
  on public.profiles
  for update
  using (auth.uid() = id)
  with check (auth.uid() = id);

-- Profiles are inserted by the backend using the service role key.
-- Do not allow clients to insert profiles directly.
