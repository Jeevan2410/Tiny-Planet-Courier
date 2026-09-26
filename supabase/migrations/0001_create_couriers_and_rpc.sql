-- Tiny Planet Courier: anonymous courier profiles and the leaderboard.
--
-- Design note: this is a browser game with no sign-in, so the anon key is
-- public by definition. The table therefore grants anon NOTHING directly --
-- RLS is on with no policies -- and every read and write goes through a
-- SECURITY DEFINER function that validates and clamps its inputs. Session ids
-- are client-generated UUIDs, which are infeasible to guess, so knowing your
-- own id is what authorises writing your own row.

create table if not exists public.couriers (
  id               text primary key,
  name             text        not null default 'Courier',
  outfit           smallint    not null default 0,
  hat              smallint    not null default 0,
  skin             smallint    not null default 1,
  best_score       integer     not null default 0,
  total_deliveries integer     not null default 0,
  best_streak      integer     not null default 0,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),

  constraint couriers_id_len      check (char_length(id) between 8 and 64),
  constraint couriers_name_len    check (char_length(name) between 1 and 24),
  constraint couriers_outfit_rng  check (outfit  between 0 and 15),
  constraint couriers_hat_rng     check (hat     between 0 and 15),
  constraint couriers_skin_rng    check (skin    between 0 and 15),
  constraint couriers_score_rng   check (best_score       between 0 and 10000000),
  constraint couriers_deliv_rng   check (total_deliveries between 0 and 1000000),
  constraint couriers_streak_rng  check (best_streak      between 0 and 100000)
);

comment on table public.couriers is
  'Anonymous courier profiles. Written only via public.upsert_courier().';

-- Leaderboard ordering.
create index if not exists couriers_best_score_idx
  on public.couriers (best_score desc)
  where best_score > 0;

alter table public.couriers enable row level security;
-- Intentionally no policies: direct table access is denied to anon and
-- authenticated alike. The functions below are the only API.
revoke all on table public.couriers from anon, authenticated;


-- Upsert a courier, keeping the best of each score column ------------------
create or replace function public.upsert_courier(
  p_id         text,
  p_name       text,
  p_outfit     integer,
  p_hat        integer,
  p_skin       integer,
  p_score      integer,
  p_deliveries integer,
  p_streak     integer
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_name text;
begin
  if p_id is null or char_length(p_id) not between 8 and 64 then
    raise exception 'invalid courier id' using errcode = '22023';
  end if;

  v_name := left(nullif(btrim(coalesce(p_name, '')), ''), 24);
  v_name := coalesce(v_name, 'Courier');

  insert into public.couriers as c (
    id, name, outfit, hat, skin, best_score, total_deliveries, best_streak
  )
  values (
    p_id,
    v_name,
    least(greatest(coalesce(p_outfit, 0), 0), 15),
    least(greatest(coalesce(p_hat, 0), 0), 15),
    least(greatest(coalesce(p_skin, 1), 0), 15),
    least(greatest(coalesce(p_score, 0), 0), 10000000),
    least(greatest(coalesce(p_deliveries, 0), 0), 1000000),
    least(greatest(coalesce(p_streak, 0), 0), 100000)
  )
  on conflict (id) do update set
    name             = excluded.name,
    outfit           = excluded.outfit,
    hat              = excluded.hat,
    skin             = excluded.skin,
    -- Keep the best run, never the latest: this makes the call idempotent and
    -- safe to fire after every delivery.
    best_score       = greatest(c.best_score, excluded.best_score),
    total_deliveries = greatest(c.total_deliveries, excluded.total_deliveries),
    best_streak      = greatest(c.best_streak, excluded.best_streak),
    updated_at       = now();
end;
$$;


-- Read back one courier's own profile --------------------------------------
create or replace function public.get_courier(p_id text)
returns table (
  name             text,
  outfit           smallint,
  hat              smallint,
  skin             smallint,
  best_score       integer,
  total_deliveries integer,
  best_streak      integer
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select c.name, c.outfit, c.hat, c.skin,
         c.best_score, c.total_deliveries, c.best_streak
  from public.couriers c
  where c.id = p_id;
$$;


-- Public leaderboard. Deliberately does not expose session ids -------------
create or replace function public.leaderboard(p_limit integer default 10)
returns table (
  name             text,
  best_score       integer,
  total_deliveries integer,
  best_streak      integer
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select c.name, c.best_score, c.total_deliveries, c.best_streak
  from public.couriers c
  where c.best_score > 0
  order by c.best_score desc, c.updated_at asc
  limit least(greatest(coalesce(p_limit, 10), 1), 50);
$$;


revoke all on function public.upsert_courier(text, text, integer, integer, integer, integer, integer, integer) from public;
revoke all on function public.get_courier(text) from public;
revoke all on function public.leaderboard(integer) from public;

grant execute on function public.upsert_courier(text, text, integer, integer, integer, integer, integer, integer) to anon, authenticated;
grant execute on function public.get_courier(text) to anon, authenticated;
grant execute on function public.leaderboard(integer) to anon, authenticated;
