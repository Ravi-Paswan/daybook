-- Daybook cloud sync — run this ONCE in Supabase: Dashboard → SQL Editor → New query → paste → Run.
-- Safe to run again (idempotent).
--
-- One table holds every synced record of every user. Each row is one local IndexedDB record
-- (store + key), stored as JSON. Deletions are kept as tombstones (deleted = true, data = null)
-- so other devices learn about them. `rev` is a server-assigned, ever-increasing number that
-- devices use as a "give me everything newer than X" cursor.
-- Row Level Security guarantees a signed-in user can only ever read or write their own rows.

create sequence if not exists public.records_rev_seq;

create table if not exists public.records (
  user_id    uuid        not null default auth.uid() references auth.users (id) on delete cascade,
  store      text        not null check (char_length(store) between 1 and 32),
  key        text        not null check (char_length(key) between 1 and 200),
  data       jsonb,
  deleted    boolean     not null default false,
  client_ts  timestamptz,
  device     text,
  rev        bigint      not null default nextval('public.records_rev_seq'),
  updated_at timestamptz not null default now(),
  primary key (user_id, store, key)
);

create index if not exists records_user_rev_idx on public.records (user_id, rev);

-- Every insert/update gets a fresh rev + server timestamp (clients can't fake them).
create or replace function public.records_touch()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.rev := nextval('public.records_rev_seq');
  new.updated_at := now();
  return new;
end
$$;

drop trigger if exists records_touch on public.records;
create trigger records_touch
  before insert or update on public.records
  for each row execute function public.records_touch();

-- Row Level Security: own rows only.
alter table public.records enable row level security;

drop policy if exists "records_select_own" on public.records;
drop policy if exists "records_insert_own" on public.records;
drop policy if exists "records_update_own" on public.records;
drop policy if exists "records_delete_own" on public.records;

create policy "records_select_own" on public.records
  for select to authenticated using ((select auth.uid()) = user_id);
create policy "records_insert_own" on public.records
  for insert to authenticated with check ((select auth.uid()) = user_id);
create policy "records_update_own" on public.records
  for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy "records_delete_own" on public.records
  for delete to authenticated using ((select auth.uid()) = user_id);

revoke all on public.records from anon;
grant select, insert, update, delete on public.records to authenticated;
grant usage, select on sequence public.records_rev_seq to authenticated;

-- Live updates: let Supabase Realtime announce changes to this table (it still applies RLS per user).
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'records'
  ) then
    alter publication supabase_realtime add table public.records;
  end if;
end
$$;
