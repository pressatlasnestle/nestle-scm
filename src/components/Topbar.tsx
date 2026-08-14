"use client";

import { usePathname } from "next/navigation";
import { signOut } from "@/lib/actions/auth";
import type { AppRole } from "@/lib/auth";

const TITLES: Record<string, [string, string]> = {
  "/articles": [
    "Articles",
    "Every captured story — review, exclude, or delete.",
  ],
  "/media-universe": [
    "Media Universe",
    "Sources the ingestion pipeline reads from, and how the universe is scoped.",
  ],
  "/keywords": [
    "Keywords",
    "Terms matched against every article during ingestion.",
  ],
  "/users": [
    "Users & Roles",
    "Who can access the dashboard, and what they're allowed to do.",
  ],
  "/integrations": [
    "Integrations",
    "API keys for analysis and delivery — stored encrypted, never displayed.",
  ],
  "/recipients": ["Recipients", "The Monday digest distribution list."],
  "/newsletter": [
    "Newsletter",
    "Compose the monthly Ocean Freight Update — AOA, then export it to paste out.",
  ],
  "/audit-log": [
    "Audit Log",
    "Every curate/admin action, permanently recorded.",
  ],
};

function initials(name: string | null, email: string | null): string {
  if (name) {
    const parts = name.trim().split(/\s+/);
    return (parts[0]?.[0] ?? "" ) + (parts[1]?.[0] ?? "");
  }
  return (email?.[0] ?? "?").toUpperCase();
}

export function Topbar({
  role,
  fullName,
  email,
}: {
  role: AppRole | null;
  fullName: string | null;
  email: string | null;
}) {
  const pathname = usePathname();
  const key = Object.keys(TITLES).find(
    (k) => pathname === k || pathname.startsWith(k + "/")
  );
  const [title, sub] = key ? TITLES[key] : ["Admin", ""];

  return (
    <div className="topbar">
      <div>
        <div className="topbar-title">{title}</div>
        <div className="topbar-sub">{sub}</div>
      </div>
      <div className="topbar-right">
        {role && (
          <div className="role-chip" title={email ?? undefined}>
            {role} role
          </div>
        )}
        <form action={signOut}>
          <button className="btn btn-sm btn-ghost" type="submit">
            Sign out
          </button>
        </form>
        <div className="avatar">{initials(fullName, email).toUpperCase()}</div>
      </div>
    </div>
  );
}
