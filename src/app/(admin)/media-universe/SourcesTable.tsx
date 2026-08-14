"use client";

import { useMemo, useState, useTransition } from "react";
import type { Tables } from "@/types/database.types";
import { useToast } from "@/components/Toast";
import { ConfirmModal } from "@/components/ConfirmModal";
import { PolarityFilter, type PolarityValue } from "@/components/PolarityFilter";
import { relativeTime } from "@/lib/format";
import {
  addSource,
  deleteSource,
  setSourceActive,
  setSourceFetchable,
  type ListTypeInput,
} from "./actions";

type Source = Tables<"sources">;

function health(s: Source): { dot: string; text: string; cls: string } {
  // Before last_fetch_status, and not derived from it. A not-fetchable source
  // keeps whatever status its last attempt left behind — often 'error', from
  // back when it was being asked for a feed it does not have. Reading that as
  // ill health would be reporting a problem that has been resolved by deciding
  // not to have it.
  if (s.is_fetchable === false) {
    return {
      dot: "idle",
      text: "Not fetched · no feed",
      cls: "mono-dim",
    };
  }

  switch (s.last_fetch_status) {
    case "ok":
      return { dot: "ok", text: `OK · ${relativeTime(s.last_fetched_at)}`, cls: "mono-dim" };
    case "no_new_items":
      return {
        dot: "warn",
        text: `No new items · ${relativeTime(s.last_fetched_at)}`,
        cls: "mono-dim health-warn",
      };
    case "error":
      return {
        dot: "err",
        text: `Fetch failed · ${relativeTime(s.last_fetched_at)}`,
        cls: "mono-dim health-err",
      };
    default:
      return { dot: "idle", text: "Never fetched", cls: "mono-dim" };
  }
}

function listBadge(listType: string | null) {
  if (listType === "positive")
    return <span className="badge badge-positive">Positive</span>;
  if (listType === "negative")
    return <span className="badge badge-negative">Negative</span>;
  return <span className="badge badge-neutral">Neutral</span>;
}

export function SourcesTable({
  initialSources,
  canEdit,
}: {
  initialSources: Source[];
  canEdit: boolean;
}) {
  const toast = useToast();
  const [filter, setFilter] = useState("");
  const [polarity, setPolarity] = useState<PolarityValue>("all");
  const [pending, startTransition] = useTransition();

  // add-form state
  const [name, setName] = useState("");
  const [rssUrl, setRssUrl] = useState("");
  const [listType, setListType] = useState<ListTypeInput>("neutral");
  const [category, setCategory] = useState("");

  const [toDelete, setToDelete] = useState<Source | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const sources = initialSources;

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return sources.filter((s) => {
      const matchesText = !q || s.name.toLowerCase().includes(q);
      const matchesPolarity =
        polarity === "all"
          ? true
          : polarity === "positive"
            ? s.list_type === "positive"
            : polarity === "negative"
              ? s.list_type === "negative"
              : // neutral = neither positive nor negative (list_type is null)
                s.list_type !== "positive" && s.list_type !== "negative";
      return matchesText && matchesPolarity;
    });
  }, [sources, filter, polarity]);

  const filtering = filter.trim() !== "" || polarity !== "all";

  function submitAdd(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) {
      toast.error("Source name is required.");
      return;
    }
    startTransition(async () => {
      const res = await addSource({ name, rssUrl, listType, category });
      if (res.ok) {
        toast.success(`Added “${name.trim()}”.`);
        setName("");
        setRssUrl("");
        setListType("neutral");
        setCategory("");
      } else {
        toast.error(res.error);
      }
    });
  }

  function confirmDelete() {
    if (!toDelete) return;
    const target = toDelete;
    setBusyId(target.id);
    startTransition(async () => {
      const res = await deleteSource(target.id);
      setBusyId(null);
      setToDelete(null);
      if (res.ok) toast.success(`Deleted “${target.name}”.`);
      else toast.error(res.error);
    });
  }

  function toggleActive(s: Source) {
    setBusyId(s.id);
    startTransition(async () => {
      const res = await setSourceActive(s.id, !s.is_active);
      setBusyId(null);
      if (!res.ok) toast.error(res.error);
    });
  }

  function toggleFetchable(s: Source) {
    setBusyId(s.id);
    startTransition(async () => {
      const res = await setSourceFetchable(s.id, !s.is_fetchable);
      setBusyId(null);
      // Turning fetching on for a source with no URL is refused server-side.
      // Surfaced as a message rather than a disabled control, because the
      // reason ("add a feed URL first") is the useful part.
      if (!res.ok) toast.error(res.error);
    });
  }

  return (
    <>
      <div className="table-card">
        {canEdit && (
          <form className="add-form" onSubmit={submitAdd}>
            <input
              type="text"
              placeholder="Source name"
              style={{ width: 160 }}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
            <input
              type="text"
              placeholder="RSS feed URL"
              style={{ width: 260 }}
              value={rssUrl}
              onChange={(e) => setRssUrl(e.target.value)}
            />
            <select
              value={listType}
              onChange={(e) => setListType(e.target.value as ListTypeInput)}
            >
              <option value="neutral">Neutral</option>
              <option value="positive">Positive</option>
              <option value="negative">Negative</option>
            </select>
            <input
              type="text"
              placeholder="Category (optional)"
              style={{ width: 150 }}
              value={category}
              onChange={(e) => setCategory(e.target.value)}
            />
            <button className="btn btn-primary btn-sm" type="submit" disabled={pending}>
              {pending ? "Adding…" : "Add source"}
            </button>
          </form>
        )}

        <div className="table-toolbar" style={{ flexWrap: "wrap" }}>
          <input
            className="search-input"
            placeholder="Filter by name…"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
          <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
            <PolarityFilter
              value={polarity}
              onChange={setPolarity}
              options={[
                { value: "all", label: "All" },
                { value: "positive", label: "Positive" },
                { value: "negative", label: "Negative" },
                { value: "neutral", label: "Neutral" },
              ]}
            />
            <span className="cell-sub">
              {filtering
                ? `${filtered.length} of ${sources.length} sources`
                : `${sources.length} source${sources.length === 1 ? "" : "s"}`}
            </span>
          </div>
        </div>

        {sources.length === 0 ? (
          <div className="empty-state">
            <div className="empty-title">No sources yet</div>
            <div className="empty-sub">
              {canEdit
                ? "Add the first RSS source above to start building the media universe."
                : "No sources have been added yet."}
            </div>
          </div>
        ) : (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Source</th>
                  <th>List</th>
                  <th>Category</th>
                  <th>Health</th>
                  {/* Two switches, because they answer different questions:
                      Active is "do we monitor this at all", Fetch is "does it
                      have a feed to read". A paywalled publisher is monitored
                      via the aggregator sweeps and has no feed — one switch
                      could not say that. */}
                  <th>Fetch</th>
                  <th>Active</th>
                  {canEdit && <th />}
                </tr>
              </thead>
              <tbody>
                {filtered.map((s) => {
                  const h = health(s);
                  const busy = busyId === s.id && pending;
                  return (
                    <tr key={s.id} className={busy ? "row-fading" : undefined}>
                      <td>
                        <div className="name-cell">
                          <span className={`src-dot ${h.dot}`} />
                          <div>
                            <div className="src-name">{s.name}</div>
                            <div className="src-domain">
                              {s.website_domain || s.rss_url || "—"}
                            </div>
                          </div>
                        </div>
                      </td>
                      <td>{listBadge(s.list_type)}</td>
                      <td className="mono-dim">{s.category || "—"}</td>
                      <td>
                        <div className={h.cls} title={s.last_fetch_error || undefined}>
                          {h.text}
                        </div>
                      </td>
                      <td>
                        <button
                          type="button"
                          className={`switch${s.is_fetchable ? " on" : ""}`}
                          aria-label={
                            s.is_fetchable
                              ? "Stop fetching this feed"
                              : "Fetch this feed"
                          }
                          title={
                            s.is_fetchable
                              ? "Fetched for RSS on every run."
                              : "Not fetched — no feed. Still in the universe and still covered by the aggregator sweeps."
                          }
                          disabled={!canEdit || busy}
                          onClick={() => toggleFetchable(s)}
                        />
                      </td>
                      <td>
                        <button
                          type="button"
                          className={`switch${s.is_active ? " on" : ""}`}
                          aria-label={s.is_active ? "Deactivate" : "Activate"}
                          disabled={!canEdit || busy}
                          onClick={() => toggleActive(s)}
                        />
                      </td>
                      {canEdit && (
                        <td>
                          <div className="row-actions">
                            <button
                              type="button"
                              className="row-delete"
                              onClick={() => setToDelete(s)}
                            >
                              Delete
                            </button>
                          </div>
                        </td>
                      )}
                    </tr>
                  );
                })}
                {filtered.length === 0 && (
                  <tr>
                    <td colSpan={canEdit ? 7 : 6} className="mono-dim">
                      No sources match the current filter.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="panel-foot-note">
        Negative sources are always excluded, in both universe modes. Deleting a
        source is permanent — it stops future pulls and cannot be undone, though
        prior articles from it are kept.
      </div>

      <ConfirmModal
        open={toDelete !== null}
        title={toDelete ? `Delete ${toDelete.name}?` : ""}
        destructive
        confirmLabel="Delete source"
        busy={busyId !== null && pending}
        onConfirm={confirmDelete}
        onCancel={() => setToDelete(null)}
        body={
          toDelete ? (
            <>
              Stops future pulls from <strong>{toDelete.name}</strong>.
              Already-ingested articles stay, tagged “source removed.” This
              cannot be undone.
            </>
          ) : null
        }
      />
    </>
  );
}
