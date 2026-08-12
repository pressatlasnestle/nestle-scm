"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

export type NavItem = { label: string; href: string };

/**
 * `items` is already filtered by role on the server, so admin-only sections are
 * never sent to the client for read/curate users — they are absent from the DOM,
 * not merely hidden.
 */
export function Sidebar({ items }: { items: NavItem[] }) {
  const pathname = usePathname();

  return (
    <aside className="sidebar">
      <div className="brand">
        <div className="brand-mark">SM</div>
        <div>
          <div className="brand-text">SCM Media Monitor</div>
          <div className="brand-sub">Admin console</div>
        </div>
      </div>

      <div className="nav-label">Workspace</div>
      <Link
        href="/articles"
        className={`nav-item${
          pathname === "/articles" || pathname.startsWith("/articles/")
            ? " active"
            : ""
        }`}
      >
        <span className="dot" /> Articles
      </Link>
      {/* Read-visible to every role, same tier as Newsletter — the panel is
          read-only apart from the admin/curate-gated Regenerate action, which
          gates itself. */}
      <Link
        href="/analysis"
        className={`nav-item${
          pathname === "/analysis" || pathname.startsWith("/analysis/")
            ? " active"
            : ""
        }`}
      >
        <span className="dot" /> Analysis
      </Link>

      <div className="nav-label">Settings</div>
      {items.map((item) => {
        const active =
          pathname === item.href || pathname.startsWith(item.href + "/");
        return (
          <Link
            key={item.href}
            href={item.href}
            className={`nav-item${active ? " active" : ""}`}
          >
            <span className="dot" /> {item.label}
          </Link>
        );
      })}

      <div className="sidebar-foot">
        <div>
          <b>Project</b> · nestle-scm
        </div>
        <div>
          <b>DB</b> · SCM (ap-south-1)
        </div>
        <div>
          <b>Mode</b> · pro bono / test
        </div>
      </div>
    </aside>
  );
}
