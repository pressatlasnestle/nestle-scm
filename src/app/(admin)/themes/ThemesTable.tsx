"use client";

import { useState, useTransition, type CSSProperties } from "react";
import { useToast } from "@/components/Toast";
import { ConfirmModal } from "@/components/ConfirmModal";
import { shortDate } from "@/lib/format";
import {
  addTheme,
  deleteTheme,
  setThemeActive,
  updateThemeDescription,
} from "./actions";

export type ThemeRow = {
  id: string;
  name: string;
  description: string | null;
  is_active: boolean;
  created_at: string;
  added_by_email: string | null;
  /** Articles currently carrying this theme. Surfaces dead buckets. */
  article_count: number;
};

const inputStyle: CSSProperties = {
  background: "var(--panel-raised)",
  border: "1px solid var(--line)",
  borderRadius: 7,
  padding: "8px 11px",
  fontSize: 12.5,
  color: "var(--text)",
  fontFamily: "var(--font-body)",
  width: "100%",
};

export function ThemesTable({
  initialThemes,
  canEdit,
}: {
  initialThemes: ThemeRow[];
  canEdit: boolean;
}) {
  const toast = useToast();
  const [pending, startTransition] = useTransition();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [toDelete, setToDelete] = useState<ThemeRow | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");

  const themes = initialThemes;
  const activeCount = themes.filter((t) => t.is_active).length;

  function submitAdd(e: React.FormEvent) {
    e.preventDefault();
    startTransition(async () => {
      const res = await addTheme({ name, description });
      if (res.ok) {
        toast.success(`Added “${name.trim()}”. Available to the next coding run.`);
        setName("");
        setDescription("");
      } else {
        toast.error(res.error);
      }
    });
  }

  function toggle(row: ThemeRow) {
    setBusyId(row.id);
    startTransition(async () => {
      const res = await setThemeActive(row.id, !row.is_active);
      setBusyId(null);
      if (res.ok) {
        toast.success(
          row.is_active
            ? `“${row.name}” retired. Articles already tagged keep it.`
            : `“${row.name}” reactivated.`
        );
      } else toast.error(res.error);
    });
  }

  function saveDescription(row: ThemeRow) {
    setBusyId(row.id);
    startTransition(async () => {
      const res = await updateThemeDescription(row.id, draft);
      setBusyId(null);
      if (res.ok) {
        setEditing(null);
        toast.success("Guidance updated. Applies from the next coding run.");
      } else toast.error(res.error);
    });
  }

  function confirmDelete() {
    if (!toDelete) return;
    const target = toDelete;
    setBusyId(target.id);
    startTransition(async () => {
      const res = await deleteTheme(target.id);
      setBusyId(null);
      setToDelete(null);
      if (res.ok) toast.success(`Deleted “${target.name}”.`);
      else toast.error(res.error);
    });
  }

  return (
    <>
      <div className="panel-head">
        <div>
          <h1>Themes</h1>
          <p>
            The closed vocabulary AI coding assigns from. Active names are
            compiled into the model&rsquo;s response schema, so it{" "}
            <strong>cannot</strong> return anything off this list. The
            description is not a label — it is the guidance the classifier reads
            to decide what belongs in each bucket, so it is worth writing
            carefully. Changes apply from the next coding run; nothing is cached.
          </p>
        </div>
      </div>

      {canEdit && (
        <div className="table-card" style={{ marginBottom: 16 }}>
          <form onSubmit={submitAdd} style={{ padding: 16 }}>
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              <input
                style={inputStyle}
                placeholder="Theme name — e.g. Freight rates & commercial terms"
                value={name}
                onChange={(e) => setName(e.target.value)}
                disabled={pending}
              />
              <textarea
                style={{ ...inputStyle, minHeight: 74, resize: "vertical" }}
                placeholder="Guidance for the classifier: what belongs here, and where the boundary sits against the themes it could be confused with."
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                disabled={pending}
              />
              <div>
                <button className="btn btn-primary btn-sm" disabled={pending}>
                  {pending ? "Adding…" : "Add theme"}
                </button>
              </div>
            </div>
          </form>
        </div>
      )}

      <div className="table-card">
        <div className="table-toolbar">
          <span className="cell-sub">
            {activeCount} active of {themes.length}
          </span>
        </div>

        {themes.length === 0 ? (
          <div className="empty-state">
            <div className="empty-title">No themes</div>
            <div className="empty-sub">
              AI coding cannot run until at least one theme is active.
            </div>
          </div>
        ) : (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Theme</th>
                  <th>Classifier guidance</th>
                  <th>Articles</th>
                  <th>Added</th>
                  {canEdit && <th />}
                </tr>
              </thead>
              <tbody>
                {themes.map((t) => (
                  <tr key={t.id} style={t.is_active ? undefined : { opacity: 0.55 }}>
                    <td style={{ maxWidth: 220 }}>
                      <div style={{ fontWeight: 600 }}>{t.name}</div>
                      <div style={{ marginTop: 4 }}>
                        <span
                          className="badge"
                          style={
                            t.is_active
                              ? { background: "var(--teal-dim)", color: "var(--teal)" }
                              : {
                                  background: "var(--panel-raised)",
                                  color: "var(--text-muted)",
                                }
                          }
                        >
                          {t.is_active ? "active" : "retired"}
                        </span>
                      </div>
                    </td>
                    <td style={{ maxWidth: 520 }}>
                      {editing === t.id ? (
                        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                          <textarea
                            style={{ ...inputStyle, minHeight: 90, resize: "vertical" }}
                            value={draft}
                            onChange={(e) => setDraft(e.target.value)}
                            disabled={pending}
                          />
                          <div style={{ display: "flex", gap: 8 }}>
                            <button
                              className="btn btn-primary btn-sm"
                              onClick={() => saveDescription(t)}
                              disabled={pending}
                            >
                              Save
                            </button>
                            <button
                              className="btn btn-sm"
                              onClick={() => setEditing(null)}
                              disabled={pending}
                            >
                              Cancel
                            </button>
                          </div>
                        </div>
                      ) : (
                        <div
                          className="cell-sub"
                          style={{ whiteSpace: "normal", lineHeight: 1.5 }}
                        >
                          {t.description ?? (
                            <span style={{ color: "var(--coral)" }}>
                              No guidance — the classifier only sees the name.
                            </span>
                          )}
                        </div>
                      )}
                    </td>
                    <td className="mono-dim">
                      {t.article_count === 0 && t.is_active ? (
                        <span
                          title="No article has been coded into this theme yet — a dead bucket. Either the guidance is too narrow, or the corpus has not covered it."
                          style={{ color: "var(--amber)" }}
                        >
                          0
                        </span>
                      ) : (
                        t.article_count
                      )}
                    </td>
                    <td className="mono-dim">
                      {shortDate(t.created_at)}
                      {t.added_by_email && (
                        <div className="cell-sub">{t.added_by_email}</div>
                      )}
                    </td>
                    {canEdit && (
                      <td>
                        <div className="row-actions">
                          <button
                            type="button"
                            className="row-delete"
                            style={{ color: "var(--text-muted)" }}
                            disabled={busyId === t.id || pending}
                            onClick={() => {
                              setEditing(t.id);
                              setDraft(t.description ?? "");
                            }}
                          >
                            Edit guidance
                          </button>
                          <button
                            type="button"
                            className="row-delete"
                            style={{ color: "var(--amber)" }}
                            disabled={busyId === t.id || pending}
                            onClick={() => toggle(t)}
                          >
                            {t.is_active ? "Retire" : "Reactivate"}
                          </button>
                          <button
                            type="button"
                            className="row-delete"
                            disabled={busyId === t.id || pending}
                            onClick={() => setToDelete(t)}
                          >
                            Delete
                          </button>
                        </div>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {!canEdit && (
        <div className="panel-foot-note">
          You have read access. Editing the theme vocabulary requires the admin
          role.
        </div>
      )}

      <ConfirmModal
        open={toDelete !== null}
        title={`Delete “${toDelete?.name ?? ""}”?`}
        destructive
        confirmLabel="Delete theme"
        busy={busyId !== null}
        onConfirm={confirmDelete}
        onCancel={() => setToDelete(null)}
        body={
          <>
            {toDelete && toDelete.article_count > 0 ? (
              <>
                <strong>{toDelete.article_count}</strong> article
                {toDelete.article_count === 1 ? "" : "s"} still carry this theme.
                Deleting the row does not untag them — they keep the raw string,
                which will then belong to no theme you can see or manage.{" "}
                <strong>Retire it instead</strong> unless you mean to orphan
                those tags.
              </>
            ) : (
              <>
                This theme has no coded articles, so deleting it leaves nothing
                orphaned. Retiring is still the reversible option.
              </>
            )}
          </>
        }
      />
    </>
  );
}
