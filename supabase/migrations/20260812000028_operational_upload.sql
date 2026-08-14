-- ============================================================================
-- nestle-scm — atomic apply for the operational CSV upload
--
-- No new tables and no new columns. This is one function over the three tables
-- the weekly grid already writes, and it exists for two properties PostgREST
-- cannot give from the client.
--
-- 1. ONE TRANSACTION. An upload is up to 7 days x (2 global + 5 regions +
--    10 fleet + 25 port) values. Sent as separate upserts, a file that fails on
--    its fortieth row leaves thirty-nine written and the user with no idea
--    which. A function body is a single transaction: it all lands or none of
--    it does, including when the ports foreign key rejects a name.
--
-- 2. BLANK LEAVES THE EXISTING VALUE ALONE. The brief is explicit: a blank cell
--    is not zero and not null, it is "do not touch this". That is a MERGE, not
--    a replace, and it is not expressible as a plain upsert:
--
--      * scalar columns take coalesce(new, existing), so a null in the payload
--        means "unchanged" rather than "clear it";
--      * region_data merges key by key, so a file carrying only North Asia does
--        not wipe the other four regions off that day;
--      * status_data merges TWO levels deep, because each status holds
--        {ships, teu} and a file carrying only Ships must not drop the TEU
--        figure entered last week.
--
--    That last one is the subtle case. A shallow jsonb merge would replace the
--    whole {ships, teu} object for a status and silently discard the half the
--    file did not mention.
--
--    NOTE this differs from the grid, which sends every cell and therefore
--    treats a cleared cell as a clear. The upload cannot: it has no way to tell
--    "left blank because there is no figure" from "left blank because I only
--    filled in Tuesday".
--
-- SECURITY INVOKER, deliberately. The function runs as the caller, so
-- can_curate() on each table is still the gate and a read user calling this RPC
-- directly is refused by the same policy that refuses a direct insert. A
-- SECURITY DEFINER function here would quietly become a way around RLS.
--
-- search_path is pinned regardless, because a function that resolves table
-- names through a caller-controlled search_path is a hazard even without
-- elevated rights.
-- ============================================================================

create or replace function public.apply_operational_upload(p_payload jsonb)
returns jsonb
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_entry        jsonb;
  v_day          date;
  v_existing     jsonb;
  v_incoming     jsonb;
  v_merged       jsonb;
  v_status       text;
  v_congestion   int := 0;
  v_fleet        int := 0;
  v_ports        int := 0;
begin
  -- --- Congestion: scalars coalesce, region_data merges by key -------------
  for v_entry in select * from jsonb_array_elements(coalesce(p_payload->'congestion', '[]'::jsonb))
  loop
    v_day := (v_entry->>'day_of')::date;

    select coalesce(region_data, '{}'::jsonb) into v_existing
      from operational_congestion where day_of = v_day;
    v_existing := coalesce(v_existing, '{}'::jsonb);
    v_incoming := coalesce(v_entry->'region_data', '{}'::jsonb);

    insert into operational_congestion as t
      (day_of, global_teu_waiting, global_pct_fleet, region_data, entered_by, entered_at)
    values (
      v_day,
      nullif(v_entry->>'global_teu_waiting', '')::numeric,
      nullif(v_entry->>'global_pct_fleet', '')::numeric,
      v_existing || v_incoming,
      auth.uid(),
      now()
    )
    on conflict (day_of) do update set
      -- coalesce(new, old): absent in the file means unchanged, never cleared.
      global_teu_waiting = coalesce(excluded.global_teu_waiting, t.global_teu_waiting),
      global_pct_fleet   = coalesce(excluded.global_pct_fleet,   t.global_pct_fleet),
      region_data        = coalesce(t.region_data, '{}'::jsonb) || v_incoming,
      entered_by         = excluded.entered_by,
      entered_at         = excluded.entered_at;

    v_congestion := v_congestion + 1;
  end loop;

  -- --- Fleet status: two-level merge ---------------------------------------
  for v_entry in select * from jsonb_array_elements(coalesce(p_payload->'fleet', '[]'::jsonb))
  loop
    v_day := (v_entry->>'day_of')::date;
    v_incoming := coalesce(v_entry->'status_data', '{}'::jsonb);

    select coalesce(status_data, '{}'::jsonb) into v_existing
      from operational_fleet_status where day_of = v_day;
    v_existing := coalesce(v_existing, '{}'::jsonb);

    -- Merge per status so a file carrying only Ships keeps the stored TEU.
    v_merged := v_existing;
    for v_status in select jsonb_object_keys(v_incoming)
    loop
      v_merged := jsonb_set(
        v_merged,
        array[v_status],
        coalesce(v_existing->v_status, '{}'::jsonb) || (v_incoming->v_status),
        true
      );
    end loop;

    insert into operational_fleet_status as t
      (day_of, status_data, entered_by, entered_at)
    values (v_day, v_merged, auth.uid(), now())
    on conflict (day_of) do update set
      status_data = v_merged,
      entered_by  = excluded.entered_by,
      entered_at  = excluded.entered_at;

    v_fleet := v_fleet + 1;
  end loop;

  -- --- Port congestion: scalars coalesce ------------------------------------
  for v_entry in select * from jsonb_array_elements(coalesce(p_payload->'ports', '[]'::jsonb))
  loop
    v_day := (v_entry->>'day_of')::date;

    insert into operational_port_congestion as t
      (day_of, port_name, ships_anchorage, ships_port, teu_anchorage, teu_port,
       queue_berth_ratio, entered_by, entered_at)
    values (
      v_day,
      v_entry->>'port_name',
      nullif(v_entry->>'ships_anchorage', '')::numeric,
      nullif(v_entry->>'ships_port', '')::numeric,
      nullif(v_entry->>'teu_anchorage', '')::numeric,
      nullif(v_entry->>'teu_port', '')::numeric,
      -- Stored exactly as supplied. Never recomputed from the two ship counts:
      -- Linerlytica smooths it and the figures disagree on purpose.
      nullif(v_entry->>'queue_berth_ratio', '')::numeric,
      auth.uid(),
      now()
    )
    on conflict (day_of, port_name) do update set
      ships_anchorage   = coalesce(excluded.ships_anchorage,   t.ships_anchorage),
      ships_port        = coalesce(excluded.ships_port,        t.ships_port),
      teu_anchorage     = coalesce(excluded.teu_anchorage,     t.teu_anchorage),
      teu_port          = coalesce(excluded.teu_port,          t.teu_port),
      queue_berth_ratio = coalesce(excluded.queue_berth_ratio, t.queue_berth_ratio),
      entered_by        = excluded.entered_by,
      entered_at        = excluded.entered_at;

    v_ports := v_ports + 1;
  end loop;

  return jsonb_build_object(
    'congestion_days', v_congestion,
    'fleet_days',      v_fleet,
    'port_rows',       v_ports
  );
end;
$$;

comment on function public.apply_operational_upload(jsonb) is
  'Applies a parsed operational CSV upload in ONE transaction. SECURITY INVOKER, so can_curate() on each table remains the gate. Blank values are absent from the payload and leave the stored value untouched: scalars coalesce, region_data merges by key, status_data merges two levels deep.';

-- Every app user may call it; the table policies decide what actually happens,
-- which keeps the authorisation in one place rather than two.
grant execute on function public.apply_operational_upload(jsonb) to authenticated;
