import { redirect } from "next/navigation";
import { LogOut } from "lucide-react";
import { signOut } from "@/app/login/actions";
import { Shell } from "@/components/Shell";
import { api, getSession } from "@/lib/data";

export const dynamic = "force-dynamic";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const session = await getSession();
  const allowed = await api(session).isAllowed().catch(() => false);
  // No session and guest mode off: sign in.
  if (!session.user && !allowed) redirect("/login");
  if (session.user && !allowed) {
    return (
      <div className="flex min-h-screen items-center justify-center px-6">
        <div className="card card-pad max-w-md">
          <div className="eyebrow mb-2">Access</div>
          <h1 className="display text-[28px]">This account isn't authorised</h1>
          <p className="mt-3 text-[14.5px] text-ink-2">
            You're signed in as <strong className="text-ink">{session.user.email}</strong>, but only the project owner can
            view the research data. The owner can grant access by adding this user id to the allow-list:
          </p>
          <code className="mt-3 block break-all rounded-lg border border-line bg-paper-2 p-2.5 font-mono text-[12px]">
            {session.user.id}
          </code>
          <form action={signOut} className="mt-5">
            <button className="btn" type="submit">
              <LogOut size={14} /> Sign out
            </button>
          </form>
        </div>
      </div>
    );
  }

  return (
    <Shell email={session.user?.email ?? null} fixture={session.fixture}>
      {children}
    </Shell>
  );
}
