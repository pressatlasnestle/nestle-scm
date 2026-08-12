-- ============================================================================
-- nestle-scm — themes: a CLOSED vocabulary for Stage 2 coding
--
-- Phase 3 let the coding engine name themes freely and then tried to make them
-- converge — first by normalising spelling and plurals, then by seeding the
-- prompt with themes already in use. Measured on the real corpus, that got 110
-- distinct themes down to 48, which is a large improvement and still not a
-- controlled vocabulary: one Hormuz storyline had split five ways across
-- "crisis", "risk", "conflict", "disruptions" and "shipping", and seeding only
-- discouraged that rather than preventing it.
--
-- This table makes it structural. Active theme names are compiled into the
-- Gemini response schema as an enum, so the API rejects anything off-list
-- server-side. Drift stops being a thing the prompt has to discourage.
--
-- `description` is NOT a display label. It is classifier guidance sent in the
-- prompt, so the model is told what each bucket MEANS and where the boundaries
-- are, rather than pattern-matching a bare name. Editing a description changes
-- classification behaviour on the next run — treat it as the important field.
--
-- Same lifecycle as keywords/sources: admin-managed, is_active for retirement,
-- no CHECK constraints (the write path is a form, and the vocabulary is meant
-- to move). Deactivating a theme stops it being OFFERED but never rewrites
-- articles already tagged with it — forward-only, matching how a retired
-- keyword leaves historical matched_keywords untouched.
-- ============================================================================

create table public.themes (
  id          uuid primary key default gen_random_uuid(),
  name        text not null unique,
  description text,
  is_active   boolean not null default true,
  added_by    uuid references public.profiles(id) on delete set null,
  created_at  timestamptz not null default now()
);

comment on table public.themes is
  'Closed vocabulary for articles.ai_themes. Active names are compiled into the coding call''s response schema as an enum, so Gemini cannot return an off-list theme. Deactivating is forward-only: it stops the theme being offered, and never rewrites already-tagged articles.';

comment on column public.themes.description is
  'Classifier guidance, sent to the model in the coding prompt — not a display label. Says what the bucket means and where its boundaries are. Editing this changes how articles are coded on the next run.';

comment on column public.themes.is_active is
  'false = retired. Not offered to the coding engine any more; articles already carrying the theme keep it.';

-- ---------------------------------------------------------------------------
-- RLS: read for every active app user (the Articles panel renders themes and
-- the coding engine reads them), write for admin only — same split as
-- sources / keywords / app_settings.
-- ---------------------------------------------------------------------------
alter table public.themes enable row level security;

create policy themes_select_app_users
  on public.themes for select to authenticated
  using (public.is_app_user());

create policy themes_admin_write
  on public.themes for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

-- ---------------------------------------------------------------------------
-- Seed: 11 themes.
--
-- Derived from the real coded corpus (48 free-text themes over 73 articles)
-- rolled up to the altitude of the existing Gate 2 keyword clusters, so the
-- vocabulary is durable rather than shaped by whatever dominated one 10-month
-- window. Two are seeded knowing they are currently empty:
--
--   * 'Regulation & decarbonisation' had ZERO articles in the corpus. It is a
--     real beat with nine keyword terms behind it (IMO Net-Zero, MEPC, EU ETS,
--     FuelEU, CII/EEXI, green methanol); the zero reflects a window dominated
--     by Red Sea and Arctic routing, not that it does not matter.
--   * 'Carrier strategy & corporate' had four (Hapag-Lloyd/Zim, Tercat,
--     Barcelona, terminal competition) and no home in a 10-theme cut.
--
-- Keeping both is why this is 11 and not 10. Nothing depends on the count.
--
-- Descriptions carry the boundary rules, because the confusable pairs are
-- predictable: a chokepoint closure is routing, a vessel fire is an incident;
-- a rate move is commercial, a volume move is demand.
-- ---------------------------------------------------------------------------
insert into public.themes (name, description) values
  ('Chokepoints & routing',
   'Which way ships go and why: Suez/Red Sea, Panama, Bab al-Mandeb, Hormuz, Malacca, Cape of Good Hope, Arctic and Northern Sea Route. Rerouting decisions, transit advisories, canal draft and booking restrictions, returns to or departures from a corridor. Use this when the story is about the ROUTE; use Disruption & incidents when it is about a single casualty or attack.'),
  ('Port & terminal operations',
   'What happens inside a container port or terminal: congestion, berth and yard utilisation, dwell and waiting times, throughput volumes, gate and rail interchange, terminal equipment, automation and electrification, capacity expansion and new terminal infrastructure.'),
  ('Service network changes',
   'The shape of the liner network: new, suspended, withdrawn or rerouted services, string and rotation changes, port omissions and additions, new direct connections, alliance service reshuffles. Use this for what the network DOES; use Carrier strategy & corporate for who owns whom.'),
  ('Demand & trade volumes',
   'How much cargo is moving: import and export volumes, container throughput as a demand signal, peak season timing, frontloading ahead of tariffs or holidays, inventory restocking and destocking, trade-lane demand shifts.'),
  ('Disruption & incidents',
   'Discrete events that interrupt cargo movement: port and labour strikes, weather closures, storms and low water, vessel fires, groundings, collisions, sinkings, containers overboard, salvage and wreck removal, piracy, drone or missile attacks, vessel seizure and interception, cyberattacks on carriers or ports, earthquakes.'),
  ('Trade policy & sanctions',
   'State action that changes the cost or legality of moving cargo: tariffs and duties, Section 301 and USTR port fees, de minimis rules, export restrictions and controls, customs procedure and delays, sanctions regimes, vessel and carrier designations, sanctions compliance.'),
  ('Capacity, fleet & equipment',
   'Supply of ships and boxes: orderbook and newbuilding contracts, deliveries, scrapping and demolition, idle and laid-up fleet, overcapacity and undercapacity, ULCV and megamax vessels, container equipment availability, box shortages and repositioning.'),
  ('Freight rates & commercial terms',
   'What shippers pay: spot and contract rates, general rate increases, all surcharges (bunker, congestion, peak season, war risk, ETS, carbon), demurrage and detention, charter rates, index movements (SCFI, CCFI, WCI, FBX, Xeneta XSI), contract negotiation and index-linked deals.'),
  ('Schedule & reliability',
   'Whether services run to plan: schedule reliability and on-time performance, blank and cancelled sailings, transit times, slow steaming, vessel bunching, rolled cargo, service suspensions on reliability grounds. Use this for systemic timekeeping; use Disruption & incidents for the one-off event that caused a specific delay.'),
  ('Regulation & decarbonisation',
   'Rules and emissions: IMO and MEPC decisions, the IMO Net-Zero Framework, EU ETS maritime, FuelEU Maritime, CBAM, CII and EEXI ratings, green corridors, alternative bunker fuels (methanol, LNG dual-fuel, ammonia, biofuel), and compliance costs arising from them.'),
  ('Carrier strategy & corporate',
   'Who owns and runs what: mergers, acquisitions and divestments involving carriers or terminal operators, alliance membership changes and formation, joint ventures, carrier financial results and guidance where they signal strategy, leadership changes that carry strategic weight, market share and competitive positioning.')
on conflict (name) do nothing;
