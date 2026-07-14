-- Solo leaderboard: +3 points per full-match win (public or friends).

create table if not exists public.leaderboard (
  user_id uuid primary key references public.profiles (id) on delete cascade,
  points integer not null default 0 check (points >= 0),
  wins integer not null default 0 check (wins >= 0),
  updated_at timestamptz not null default now()
);

create index if not exists leaderboard_points_idx
  on public.leaderboard (points desc, wins desc);

-- Prevent double-award if the same finished room is processed twice.
create table if not exists public.leaderboard_match_awards (
  room_id text primary key,
  winner_team smallint not null check (winner_team in (0, 1)),
  winner_user_ids uuid[] not null,
  points_each integer not null default 3,
  awarded_at timestamptz not null default now()
);

alter table public.leaderboard enable row level security;
alter table public.leaderboard_match_awards enable row level security;

create policy "Leaderboard is publicly readable"
  on public.leaderboard
  for select
  using (true);

-- Writes go through the backend service role only.
