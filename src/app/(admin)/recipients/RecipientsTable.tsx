"use client";

import { useState, useTransition } from "react";
import type { Tables } from "@/types/database.types";
import { useToast } from "@/components/Toast";
import { ConfirmModal } from "@/components/ConfirmModal";
import { addRecipient, deleteRecipient, setRecipientActive } from "./actions";

type Recipient = Tables<"report_recipients">;

export function RecipientsTable({
  initialRecipients,
  canEdit,
}: {
  initialRecipients: Recipient[];
  canEdit: boolean;
}) {
  const toast = useToast();
  const [pending, startTransition] = useTransition();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [toDelete, setToDelete] = useState<Recipient | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const recipients = initialRecipients;

  function submitAdd(e: React.FormEvent) {
    e.preventDefault();
    if (!email.trim()) {
      toast.error("Email address is required.");
      return;
    }
    startTransition(async () => {
      const res = await addRecipient({ name, email });
      if (res.ok) {
        toast.success(`Added ${email.trim()}.`);
        setName("");
        setEmail("");
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
      const res = await deleteRecipient(target.id);
      setBusyId(null);
      setToDelete(null);
      if (res.ok) toast.success(`Removed ${target.email}.`);
      else toast.error(res.error);
    });
  }

  function toggleActive(r: Recipient) {
    setBusyId(r.id);
    startTransition(async () => {
      const res = await setRecipientActive(r.id, !r.is_active);
      setBusyId(null);
      if (!res.ok) toast.error(res.error);
    });
  }

  return (
    <>
      <div className="panel-head">
        <div>
          <h1>Recipients</h1>
          <p>
            Who receives the Monday digest email. Separate from dashboard login
            access — being a recipient does not grant a login.
          </p>
        </div>
      </div>

      <div className="table-card">
        {canEdit && (
          <form className="add-form" onSubmit={submitAdd}>
            <input
              type="text"
              placeholder="Name"
              style={{ width: 160 }}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
            <input
              type="text"
              placeholder="Email address"
              style={{ width: 220 }}
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
            <button className="btn btn-primary btn-sm" type="submit" disabled={pending}>
              {pending ? "Adding…" : "Add recipient"}
            </button>
          </form>
        )}

        {recipients.length === 0 ? (
          <div className="empty-state">
            <div className="empty-title">No recipients yet</div>
            <div className="empty-sub">
              {canEdit
                ? "Add the first recipient above — they'll receive the next Monday digest."
                : "No recipients have been added yet."}
            </div>
          </div>
        ) : (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Email</th>
                  <th>Active</th>
                  {canEdit && <th />}
                </tr>
              </thead>
              <tbody>
                {recipients.map((r) => {
                  const busy = busyId === r.id && pending;
                  return (
                    <tr key={r.id} className={busy ? "row-fading" : undefined}>
                      <td>
                        <b>{r.name || "—"}</b>
                      </td>
                      <td className="mono-dim">{r.email}</td>
                      <td>
                        <button
                          type="button"
                          className={`switch${r.is_active ? " on" : ""}`}
                          aria-label={r.is_active ? "Deactivate" : "Activate"}
                          disabled={!canEdit || busy}
                          onClick={() => toggleActive(r)}
                        />
                      </td>
                      {canEdit && (
                        <td>
                          <div className="row-actions">
                            <button
                              type="button"
                              className="icon-btn"
                              aria-label="Remove recipient"
                              onClick={() => setToDelete(r)}
                            >
                              ✕
                            </button>
                          </div>
                        </td>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <ConfirmModal
        open={toDelete !== null}
        title={toDelete ? "Remove recipient?" : ""}
        destructive
        confirmLabel="Remove recipient"
        busy={busyId !== null && pending}
        onConfirm={confirmDelete}
        onCancel={() => setToDelete(null)}
        body={
          toDelete ? (
            <>
              Stops sending the Monday digest to{" "}
              <strong>{toDelete.email}</strong>. They keep no dashboard access
              either way. You can add them back later.
            </>
          ) : null
        }
      />
    </>
  );
}
