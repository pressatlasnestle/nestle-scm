"use client";

import { useMemo, useState, useTransition } from "react";
import { useToast } from "@/components/Toast";
import { ConfirmModal } from "@/components/ConfirmModal";
import { PolarityFilter, type PolarityValue } from "@/components/PolarityFilter";
import { shortDate } from "@/lib/format";
import {
  addKeyword,
  deleteKeyword,
  setKeywordActive,
  type KeywordListType,
} from "./actions";

export type KeywordRow = {
  id: string;
  keyword: string;
  list_type: KeywordListType;
  is_active: boolean;
  created_at: string;
  added_by_email: string | null;
};

export function KeywordsTable({
  initialKeywords,
  canEdit,
}: {
  initialKeywords: KeywordRow[];
  canEdit: boolean;
}) {
  const toast = useToast();
  const [pending, startTransition] = useTransition();
  const [value, setValue] = useState("");
  const [listType, setListType] = useState<KeywordListType>("positive");
  const [filter, setFilter] = useState("");
  const [polarity, setPolarity] = useState<PolarityValue>("all");
  const [toDelete, setToDelete] = useState<KeywordRow | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const keywords = initialKeywords;

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return keywords.filter((k) => {
      const matchesText = !q || k.keyword.toLowerCase().includes(q);
      const matchesPolarity =
        polarity === "all" ? true : k.list_type === polarity;
      return matchesText && matchesPolarity;
    });
  }, [keywords, filter, polarity]);

  const filtering = filter.trim() !== "" || polarity !== "all";

  function submitAdd(e: React.FormEvent) {
    e.preventDefault();
    if (!value.trim()) {
      toast.error("Enter a keyword.");
      return;
    }
    const kw = value.trim();
    startTransition(async () => {
      const res = await addKeyword({ keyword: kw, listType });
      if (res.ok) {
        toast.success(`Added “${kw}” (${listType}).`);
        setValue("");
        setListType("positive");
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
      const res = await deleteKeyword(target.id);
      setBusyId(null);
      setToDelete(null);
      if (res.ok) toast.success(`Deleted “${target.keyword}”.`);
      else toast.error(res.error);
    });
  }

  function toggleActive(k: KeywordRow) {
    setBusyId(k.id);
    startTransition(async () => {
      const res = await setKeywordActive(k.id, !k.is_active);
      setBusyId(null);
      if (!res.ok) toast.error(res.error);
    });
  }

  return (
    <>
      <div className="panel-head">
        <div>
          <h1>Keywords</h1>
          <p>
            Articles are matched against this list during ingestion. Inactive
            keywords are kept for history but no longer used in matching.
          </p>
        </div>
      </div>

      <div className="table-card">
        {canEdit && (
          <form className="add-form" onSubmit={submitAdd}>
            <input
              type="text"
              placeholder="Add a keyword…"
              style={{ width: 240 }}
              value={value}
              onChange={(e) => setValue(e.target.value)}
            />
            <select
              value={listType}
              onChange={(e) => setListType(e.target.value as KeywordListType)}
              aria-label="Keyword type"
            >
              <option value="positive">Positive</option>
              <option value="negative">Negative</option>
            </select>
            <button className="btn btn-primary btn-sm" type="submit" disabled={pending}>
              {pending ? "Adding…" : "Add"}
            </button>
          </form>
        )}

        {keywords.length === 0 ? (
          <div className="empty-state">
            <div className="empty-title">No keywords yet</div>
            <div className="empty-sub">
              {canEdit
                ? "Add the first keyword above — it will be matched against every article on the next pull."
                : "No keywords have been added yet."}
            </div>
          </div>
        ) : (
          <>
            <div className="table-toolbar" style={{ flexWrap: "wrap" }}>
              <input
                className="search-input"
                placeholder="Filter by keyword…"
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
                  ]}
                />
                <span className="cell-sub">
                  {filtering
                    ? `${filtered.length} of ${keywords.length} keywords`
                    : `${keywords.length} keyword${keywords.length === 1 ? "" : "s"}`}
                </span>
              </div>
            </div>
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>Keyword</th>
                    <th>Type</th>
                    <th>Added by</th>
                    <th>Added</th>
                    <th>Active</th>
                    {canEdit && <th />}
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((k) => {
                  const busy = busyId === k.id && pending;
                  return (
                    <tr key={k.id} className={busy ? "row-fading" : undefined}>
                      <td style={{ color: k.is_active ? undefined : "var(--text-dim)" }}>
                        <b>{k.keyword}</b>
                      </td>
                      <td>
                        <span
                          className={`badge ${
                            k.list_type === "negative"
                              ? "badge-negative"
                              : "badge-positive"
                          }`}
                        >
                          {k.list_type === "negative" ? "Negative" : "Positive"}
                        </span>
                      </td>
                      <td className="mono-dim">{k.added_by_email ?? "—"}</td>
                      <td className="mono-dim">{shortDate(k.created_at)}</td>
                      <td>
                        <button
                          type="button"
                          className={`switch${k.is_active ? " on" : ""}`}
                          aria-label={k.is_active ? "Deactivate" : "Activate"}
                          disabled={!canEdit || busy}
                          onClick={() => toggleActive(k)}
                        />
                      </td>
                      {canEdit && (
                        <td>
                          <div className="row-actions">
                            <button
                              type="button"
                              className="row-delete"
                              onClick={() => setToDelete(k)}
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
                      <td colSpan={canEdit ? 6 : 5} className="mono-dim">
                        No keywords match the current filter.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>

      <ConfirmModal
        open={toDelete !== null}
        title={toDelete ? `Delete “${toDelete.keyword}”?` : ""}
        destructive
        confirmLabel="Delete keyword"
        busy={busyId !== null && pending}
        onConfirm={confirmDelete}
        onCancel={() => setToDelete(null)}
        body={
          toDelete ? (
            <>
              Stops matching <strong>{toDelete.keyword}</strong> on future pulls.
              Articles already tagged with it keep that tag.
            </>
          ) : null
        }
      />
    </>
  );
}
