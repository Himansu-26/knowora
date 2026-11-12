create table if not exists cache (
  hash text primary key,
  result jsonb not null,
  created_at timestamptz default now()
);
create table if not exists identifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users on delete cascade,
  query text,
  name text,
  category text,
  result jsonb,
  created_at timestamptz default now()
);
alter table identifications enable row level security;
alter table cache enable row level security;
create policy "own rows" on identifications for select using (auth.uid() = user_id);
