-- ============================================================================
-- nestle-scm — operational data: daily grain, fleet status, port congestion
--
-- Reshapes the operational section introduced in 0026 before any figures were
-- entered. Verified empty first: all three tables and every
-- 'operational_data.update' audit row were at zero. Doing this over live data
-- would be a different job with a data migration attached.
--
-- FOUR CHANGES.
--
-- 1. operational_congestion moves from weekly to DAILY. week_of becomes
--    day_of and the unique constraint moves with it.
--
--    Daily rows rather than seven days packed into a weekly jsonb blob. A blob
--    would force any future 30-day or quarterly view to unpack it, and would
--    wire the ISO week boundary into a schema with no reason to care about it.
--    The week selector becomes a 7-day range query — a query change, not a
--    structural one. A week with only Monday, Wednesday and Friday entered is
--    three rows and plots three points; it does not plot zeros for the gaps,
--    which is the absent-not-empty rule applied per day.
--
-- 2. operational_waiting_time is DROPPED, superseded by
--    operational_port_congestion, which carries the same information per port
--    in richer form. Dropped rather than left in place: a half-removed feature
--    is worse than either state.
--
-- 3. operational_fleet_status is NEW, daily. Five Linerlytica statuses, each
--    with a ship count and a TEU figure, in a jsonb blob for the same reason
--    region_data is a blob — the status list is Linerlytica's editorial choice
--    and will move.
--
--    THE STATUSES OVERLAP. On the reference figures, "Ships at port" (1,165)
--    and "Ships at anchorage" (1,180) are both subsets of "Active Ships"
--    (5,426), and sum to 2,345 — well under it. Nothing here may be stacked or
--    totalled; the chart uses grouped bars and says so in its caption.
--
-- 4. operational_port_congestion is NEW, daily, one row per (day, port).
--
--    queue_berth_ratio IS STORED, NEVER DERIVED. It is close to
--    ships_anchorage / ships_port but does not equal it. Busan 122/48 = 2.54
--    and Antwerp 17/21 = 0.81 match the published figure exactly, while
--    Shanghai/Ningbo computes 3.53 against a published 3.50 and Gibraltar
--    computes 2.63 against a published 2.80 — Linerlytica smooths it on a
--    basis not given to us. Deriving it would print numbers that disagree with
--    the document the client is reading.
--
-- operational_schedule_reliability is deliberately UNTOUCHED. It is genuinely
-- a monthly series published in arrears, and the bounded carry-forward from
-- 537fcbf is correct as it stands.
--
-- No CHECK constraints on any numeric, same discipline as everywhere else in
-- this schema: these are transcriptions of someone else's published figures,
-- and the job is to record what was published.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Weekly congestion becomes daily
-- ---------------------------------------------------------------------------
alter table public.operational_congestion rename column week_of to day_of;
alter table public.operational_congestion
  rename constraint operational_congestion_week_of_key to operational_congestion_day_of_key;

comment on table public.operational_congestion is
  'Daily port congestion, transcribed from Linerlytica. One row per day; a week is a 7-day range query, and days with no entry are simply absent.';
comment on column public.operational_congestion.day_of is
  'The calendar day the figures describe. One row per day.';

-- ---------------------------------------------------------------------------
-- 2. Waiting time is superseded
-- ---------------------------------------------------------------------------
drop table if exists public.operational_waiting_time;

-- ---------------------------------------------------------------------------
-- 3. Ports — a controlled vocabulary
--
-- Same shape and same reasoning as `themes`: free-text port names would
-- fragment across weeks ("LA/LB", "LA / LB", "Los Angeles/Long Beach") and no
-- chart could join them. operational_port_congestion carries a foreign key to
-- this table, so an unknown port is refused by the database rather than only
-- by the form.
--
-- Seeded VERBATIM from the source list, including its two typos —
-- 'Kingston (Jamica)' and 'Wilmington(NC)'. The name is the join key across
-- time: a spelling tidied next month would not match a row entered today.
-- Correcting one is a deliberate rename plus a data update, which the
-- ON UPDATE CASCADE below makes safe, not a quiet edit to this seed.
--
-- Names run to 32 characters and contain slashes and parentheses. They are
-- stored exactly as given — not slugified, split or normalised.
-- ---------------------------------------------------------------------------
create table public.ports (
  id         uuid primary key default gen_random_uuid(),
  name       text not null unique,
  is_active  boolean not null default true,
  added_by   uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now()
);

comment on table public.ports is
  'Controlled vocabulary of port names for operational_port_congestion. Seeded verbatim from Linerlytica, typos included, because the name is the join key across time.';
comment on column public.ports.is_active is
  'false = retired from the picker. Never rewrites rows already recorded against the port.';

alter table public.ports enable row level security;

create policy ports_select_app_users
  on public.ports for select to authenticated
  using (public.is_app_user());
create policy ports_admin_write
  on public.ports for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

-- ---------------------------------------------------------------------------
-- 4. Fleet status, daily
-- ---------------------------------------------------------------------------
create table public.operational_fleet_status (
  id          uuid primary key default gen_random_uuid(),
  day_of      date not null unique,
  status_data jsonb,
  entered_by  uuid references public.profiles(id) on delete set null,
  entered_at  timestamptz not null default now()
);

comment on table public.operational_fleet_status is
  'Daily fleet status from Linerlytica. The statuses OVERLAP — ships at port and ships at anchorage are both subsets of active ships — so they must never be stacked or totalled.';
comment on column public.operational_fleet_status.status_data is
  'Status to {ships, teu}: {"Active Ships": {"ships": 5426, "teu": 31000000}, ...}. jsonb because the status list is Linerlytica''s and will change.';

alter table public.operational_fleet_status enable row level security;

create policy operational_fleet_status_select_app_users
  on public.operational_fleet_status for select to authenticated
  using (public.is_app_user());
create policy operational_fleet_status_curate_write
  on public.operational_fleet_status for all to authenticated
  using (public.can_curate()) with check (public.can_curate());

-- ---------------------------------------------------------------------------
-- 5. Port congestion, daily, per port
--
-- The compound UNIQUE is a plain constraint, never a partial index: PostgREST's
-- upsert needs an arbiter it can name in ON CONFLICT. That is the lesson from
-- migration 0024, where a partial index made the upsert fail outright.
--
-- The five-port limit is a UI convention and is NOT enforced here. No CHECK, no
-- trigger. The first time a sixth port matters, a constraint costs a migration
-- where a form control costs nothing.
-- ---------------------------------------------------------------------------
create table public.operational_port_congestion (
  id                uuid primary key default gen_random_uuid(),
  day_of            date not null,
  port_name         text not null references public.ports(name) on update cascade,
  ships_anchorage   numeric,
  ships_port        numeric,
  teu_anchorage     numeric,
  teu_port          numeric,
  queue_berth_ratio numeric,
  entered_by        uuid references public.profiles(id) on delete set null,
  entered_at        timestamptz not null default now(),
  constraint operational_port_congestion_day_port_key unique (day_of, port_name)
);

comment on table public.operational_port_congestion is
  'Daily per-port congestion from Linerlytica. One row per (day, port).';
comment on column public.operational_port_congestion.queue_berth_ratio is
  'STORED AS PUBLISHED, never derived. It is close to ships_anchorage/ships_port but not equal — Shanghai/Ningbo computes 3.53 against a published 3.50 — because Linerlytica smooths it on a basis we do not have. Deriving it would print figures that disagree with the client''s own source document.';
comment on column public.operational_port_congestion.port_name is
  'FK to ports.name, so an unknown port is refused by the database and not only by the form. ON UPDATE CASCADE so a deliberate rename carries its history.';

create index operational_port_congestion_day_idx
  on public.operational_port_congestion (day_of);

alter table public.operational_port_congestion enable row level security;

create policy operational_port_congestion_select_app_users
  on public.operational_port_congestion for select to authenticated
  using (public.is_app_user());
create policy operational_port_congestion_curate_write
  on public.operational_port_congestion for all to authenticated
  using (public.can_curate()) with check (public.can_curate());

-- ---------------------------------------------------------------------------
-- Ports seed — 180 names, verbatim.
--
-- Two source typos are preserved on purpose: 'Kingston (Jamica)' and
-- 'Wilmington(NC)'. See the table comment above.
-- ---------------------------------------------------------------------------
insert into public.ports (name) values
  ('Santos'), ('Durban'), ('Mersin'), ('Lome'), ('Jeddah'),
  ('Ho Chi Minh City'), ('Harwich'), ('Puget Sound/BC (Bellingham)'),
  ('Port Qasim'), ('Fujairah'), ('Bandar Abbas'), ('Balboa'), ('Sohar'),
  ('Cotonou'), ('Colombo'), ('Manzanillo (Mexico)'), ('Cartagena'), ('Manila'),
  ('Kaohsiung'), ('Cristobal'), ('Mundra'), ('Khor Fakkan'), ('Conakry'),
  ('Salalah'), ('Casablanca'), ('Yeosu'), ('Abu Dhabi'), ('Barcelona'),
  ('Jebel Ali'), ('Surabaya'), ('Vizhinjam'), ('Chittagong'), ('Pointe Noire'),
  ('Tanjung Pelepas'), ('Xingang'), ('Port Said'), ('Alexandria'), ('Xiamen'),
  ('Nagoya'), ('Lagos'), ('Shanghai/Ningbo'), ('Shenzhen'), ('Qingdao'),
  ('Singapore'), ('Busan'), ('Antwerp'), ('Abidjan'), ('Hong Kong'),
  ('Hamburg/Bremerhaven'), ('Tema'), ('Rotterdam'), ('Port Klang'), ('Mumbai'),
  ('Gibraltar (Algeciras/Tanger Med)'), ('Valencia'), ('Savannah'),
  ('Kingston (Jamica)'), ('Adabiya'), ('Istanbul'), ('Paranagua'), ('Taipei'),
  ('La Spezia'), ('New York'), ('Zeebrugge'), ('Tauranga'), ('Callao'),
  ('Haiphong'), ('Buenos Aires'), ('Ensenada'), ('Sydney'), ('Charleston'),
  ('Dakar'), ('Kribi'), ('LA/LB'), ('Gioia Tauro'), ('Sharjah'), ('Karachi'),
  ('Houston'), ('Dar es Salaam'), ('Laem Chabang'), ('Le Havre'), ('Piraeus'),
  ('Bangkok'), ('Nhava Sheva'), ('Port Louis'), ('Port Elizabeth'), ('Miami'),
  ('London Gateway/Thamesport'), ('Monrovia'), ('Norfolk'), ('Mobile'),
  ('Nakhodka'), ('Damietta'), ('Adelaide'), ('Montevideo'), ('Taichung'),
  ('Penang'), ('Dalian'), ('Jakarta'), ('Mombasa'), ('Luanda'), ('Qinzhou'),
  ('Coronel'), ('Amsterdam'), ('Nacala'), ('Yangon'), ('Ashdod'), ('Kandla'),
  ('Tekirdag'), ('Gdansk'), ('Novorossiysk'), ('Aqaba'), ('Doha'), ('Jingtang'),
  ('Banjul'), ('Liverpool'), ('Misurata'), ('Cape Town'), ('Thessaloniki'),
  ('Bejaia'), ('Benghazi'), ('Limassol'), ('Napier'), ('Sudan'), ('Zanzibar'),
  ('Hereke'), ('Douala'), ('Tampa'), ('Port Everglades'), ('Kolkata'),
  ('Beirut'), ('Livorno'), ('Dunkirk'), ('Duqm'), ('Genoa'), ('Nantong'),
  ('Botany Bay'), ('Dammam'), ('Nouadhibou'), ('Vladivostok'), ('Incheon'),
  ('Rijeka'), ('Berbera'), ('Tuzla'), ('Haifa'), ('Gemlik'), ('Teesport'),
  ('Davao'), ('Southampton'), ('Nemrut Bay'), ('Tunis (Rades)'), ('Marsaxlokk'),
  ('Constanza'), ('Algiers'), ('Bayuquan'), ('Brunswick'), ('Melbourne'),
  ('Pipavav'), ('Lazaro Cardenas'), ('Turbo'), ('Bizerte'), ('Felixstowe'),
  ('Fuzhou'), ('Qinhuangdao'), ('Setubal'), ('Wilmington(NC)'), ('Oakland'),
  ('Port Reunion'), ('Izmit'), ('King Abdullah Port'), ('Auckland'), ('Kuwait'),
  ('Freeport (Bahamas)'), ('San Francisco'), ('Sfax'), ('Sines'),
  ('Southwest Pass'), ('Pohang'), ('Jacksonville'), ('Khalifa bin Salman');
