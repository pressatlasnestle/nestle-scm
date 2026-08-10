"use client";

import { useState, useTransition } from "react";
import { useToast } from "@/components/Toast";
import { ConfirmModal } from "@/components/ConfirmModal";
import { shortDate } from "@/lib/format";
import { setUserRole } from "./actions";

export type UserRow = {
  id: string;
  full_name: string | null;
  email: string | null;
  role: "read" | "curate" | "admin";
  is_active: boolean;
  created_at: string;
};

const ROLE_BADGE: Record<UserRow["role"], string> = {
  admin: "badge-admin",
  curate: "badge-curate",
  read: "badge-read",
};

const ROLE_LABEL: Record<UserRow["role"], string> = {
  admin: "Admin",
  curate: "Curate",
  read: "Read",
};

function consequence(name: string, next: UserRow["role"]) {
  if (next === "admin")
    return (
      <>
        Grants <strong>{name}</strong> full admin access — including user
        management, integrations, and the audit log.
      </>
    );
  if (next === "curate")
    return (
      <>
        Lets <strong>{name}</strong> exclude and delete articles, in addition to
        viewing the dashboard. No access to admin settings.
      </>
    );
  return (
    <>
      Restricts <strong>{name}</strong> to viewing the dashboard and reports
      only. Any curate/admin abilities are removed.
    </>
  );
}

export function UsersTable({
  initialUsers,
  currentUserId,
}: {
  initialUsers: UserRow[];
  currentUserId: string;
}) {
  const toast = useToast();
  const [pending, startTransition] = useTransition();
  const [change, setChange] = useState<{
    user: UserRow;
    next: UserRow["role"];
  } | null>(null);

  function confirmChange() {
    if (!change) return;
    const { user, next } = change;
    startTransition(async () => {
      const res = await setUserRole(user.id, next);
      setChange(null);
      if (res.ok)
        toast.success(`${user.full_name ?? user.email} is now ${ROLE_LABEL[next]}.`);
      else toast.error(res.error);
    });
  }

  return (
    <>
      <div className="panel-head">
        <div>
          <h1>Users &amp; Roles</h1>
          <p>
            Read can view everything. Curate can additionally exclude or delete
            articles. Admin has full control, including this panel. New users
            self-sign-up as Read; assign roles here.
          </p>
        </div>
      </div>

      <div className="table-card">
        {initialUsers.length === 0 ? (
          <div className="empty-state">
            <div className="empty-title">No users yet</div>
            <div className="empty-sub">
              Users appear here after they sign up. You can then assign each a
              role.
            </div>
          </div>
        ) : (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>User</th>
                  <th>Role</th>
                  <th>Status</th>
                  <th>Joined</th>
                </tr>
              </thead>
              <tbody>
                {initialUsers.map((u) => {
                  const isSelf = u.id === currentUserId;
                  return (
                    <tr key={u.id}>
                      <td>
                        <div>
                          <b>{u.full_name ?? "—"}</b>
                          {isSelf && (
                            <span className="cell-sub" style={{ display: "inline", marginLeft: 6 }}>
                              (you)
                            </span>
                          )}
                        </div>
                        <div className="cell-sub">{u.email}</div>
                      </td>
                      <td>
                        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                          <span className={`badge ${ROLE_BADGE[u.role]}`}>
                            {ROLE_LABEL[u.role]}
                          </span>
                          <select
                            value={u.role}
                            disabled={isSelf || pending}
                            title={
                              isSelf
                                ? "You can't change your own role"
                                : "Change role"
                            }
                            onChange={(e) => {
                              const next = e.target.value as UserRow["role"];
                              if (next !== u.role) setChange({ user: u, next });
                            }}
                            style={{
                              background: "var(--panel-raised)",
                              border: "1px solid var(--line)",
                              borderRadius: 6,
                              padding: "5px 8px",
                              fontSize: 12,
                              color: "var(--text)",
                              fontFamily: "var(--font-body)",
                            }}
                          >
                            <option value="read">Read</option>
                            <option value="curate">Curate</option>
                            <option value="admin">Admin</option>
                          </select>
                        </div>
                      </td>
                      <td>
                        <span
                          className="mono-dim"
                          style={{ color: u.is_active ? "var(--teal)" : "var(--text-dim)" }}
                        >
                          {u.is_active ? "Active" : "Inactive"}
                        </span>
                      </td>
                      <td className="mono-dim">{shortDate(u.created_at)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <ConfirmModal
        open={change !== null}
        title={
          change
            ? `Change ${change.user.full_name ?? change.user.email} to ${ROLE_LABEL[change.next]}?`
            : ""
        }
        confirmLabel="Change role"
        destructive={change?.next === "admin"}
        busy={pending}
        onConfirm={confirmChange}
        onCancel={() => setChange(null)}
        body={
          change
            ? consequence(change.user.full_name ?? change.user.email ?? "this user", change.next)
            : null
        }
      />
    </>
  );
}
