import { getSessionContext } from "@/lib/auth";
import { Sidebar, type NavItem } from "@/components/Sidebar";
import { Topbar } from "@/components/Topbar";
import { ToastProvider } from "@/components/Toast";

// Every section a role may reach. `adminOnly` items are dropped server-side
// before they are ever sent to the client, so read/curate users never receive
// Users & Roles / Integrations / Audit Log in the DOM.
const ALL_ITEMS: (NavItem & { adminOnly: boolean })[] = [
  { label: "Media Universe", href: "/media-universe", adminOnly: false },
  { label: "Keywords", href: "/keywords", adminOnly: false },
  { label: "Users & Roles", href: "/users", adminOnly: true },
  { label: "Integrations", href: "/integrations", adminOnly: true },
  { label: "Recipients", href: "/recipients", adminOnly: false },
  { label: "Audit Log", href: "/audit-log", adminOnly: true },
];

export default async function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const ctx = await getSessionContext();

  const items: NavItem[] = ALL_ITEMS.filter(
    (i) => !i.adminOnly || ctx.isAdmin
  ).map(({ label, href }) => ({ label, href }));

  return (
    <ToastProvider>
      <div className="shell">
        <Sidebar items={items} />
        <main className="main">
          <Topbar role={ctx.role} fullName={ctx.fullName} email={ctx.email} />
          <div className="content">{children}</div>
        </main>
      </div>
    </ToastProvider>
  );
}
