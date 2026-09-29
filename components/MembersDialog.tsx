"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Users } from "lucide-react";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";

interface Member {
  id: string;
  role: "OWNER" | "ADMIN" | "MEMBER";
  user: { id: string; name: string; email: string; imageUrl: string };
  isSelf: boolean;
}

export function MembersDialog() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [members, setMembers] = useState<Member[]>([]);
  const [myRole, setMyRole] = useState<string>("MEMBER");
  const [orgId, setOrgId] = useState<string | null>(null);
  const [email, setEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<"MEMBER" | "ADMIN">("MEMBER");
  const [busy, setBusy] = useState(false);

  const load = async () => {
    try {
      const res = await fetch("/api/orgs/members");
      if (!res.ok) return;
      const d = await res.json();
      setMembers(d.members ?? []);
      setMyRole(d.role ?? "MEMBER");
      setOrgId(d.organizationId ?? null);
    } catch {}
  };

  useEffect(() => {
    if (open) load();
  }, [open ]);

  const canManage = myRole === "OWNER" || myRole === "ADMIN";

  const handleDeleteOrg = async () => {
    const name = prompt("Type DELETE to permanently delete this organization and all its projects.");
    if (name !== "DELETE") return;
    const res = await fetch("/api/orgs/delete", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ organizationId: orgId }),
    });
    const d = await res.json().catch(() => null);
    if (!res.ok) {
      toast.error(d?.message ?? "Could not delete organization.");
      return;
    }
    setOpen(false);
    router.refresh();
  };

  const handleAdd = async () => {
    if (!email.trim()) return;
    setBusy(true);
    try {
      const res = await fetch("/api/orgs/members/add", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // Clerk sends the invitation email; membership lands via webhook.
        body: JSON.stringify({ email: email.trim(), role: inviteRole }),
      });
      const d = await res.json().catch(() => null);
      if (!res.ok) {
        const src = d?.source === "clerk" ? " (Clerk refused)" : "";
        toast.error(`${d?.message ?? "Could not send invite."}${src}`);
        return;
      }
      toast.success("Invitation sent via Clerk.");
      setEmail("");
      await load();
      router.refresh();
    } finally {
      setBusy(false);
    }
  };

  const handleSync = async () => {
    setBusy(true);
    try {
      const res = await fetch("/api/orgs/sync", { method: "POST" });
      const d = await res.json().catch(() => null);
      if (!res.ok) {
        toast.error(d?.message ?? "Sync failed.");
        return;
      }
      if (d?.added > 0) toast.success(`Synced ${d.added} new member${d.added !== 1 ? "s" : ""}.`);
      else toast.info("Already in sync with Clerk.");
      await load();
      router.refresh();
    } finally {
      setBusy(false);
    }
  };
  const handleRole = async (memberId: string, role: string) => {
    const res = await fetch("/api/orgs/members/role", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ memberId, role }),
    });
    const d = await res.json().catch(() => null);
    if (!res.ok) {
      toast.error(d?.message ?? "Could not update role.");
      return;
    }
    await load();
  };

  const handleRemove = async (memberId: string, isSelf: boolean) => {
    const res = await fetch("/api/orgs/members/remove", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ memberId }),
    });
    const d = await res.json().catch(() => null);
    if (!res.ok) {
      toast.error(d?.message ?? "Could not remove member.");
      return;
    }
    if (d?.selfRemoved || isSelf) {
      setOpen(false);
      router.refresh();
      return;
    }
    await load();
    router.refresh();
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger className="cursor-pointer">
        <span className="flex h-8 w-8 items-center justify-center rounded-full border border-white/10 bg-white/5 text-white/60 hover:bg-white/10 hover:text-white/90" title="Organization members">
          <Users className="h-3.5 w-3.5" />
        </span>
      </DialogTrigger>
      <DialogContent className="border-white/8 bg-[#111111] text-white sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center justify-between text-sm font-semibold text-white/90">
            <span>Organization members</span>
            <button
              onClick={handleSync}
              disabled={busy}
              className="rounded-full border border-white/10 px-2.5 py-1 text-[10px] text-white/50 hover:bg-white/10 hover:text-white/80 disabled:opacity-40"
              title="Pull latest membership from Clerk"
            >
              Sync
            </button>
          </DialogTitle>
        </DialogHeader>

        {canManage && (
          <div className="mb-3 flex gap-2">
            <input
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="teammate@company.com"
              className="h-8 flex-1 rounded-lg border border-white/10 bg-white/5 px-3 text-xs text-white/80 placeholder:text-white/25 focus:outline-none"
            />
            <select
              value={inviteRole}
              onChange={(e) => setInviteRole(e.target.value as "MEMBER" | "ADMIN")}
              className="h-8 rounded-lg border border-white/10 bg-[#1a1a1a] px-2 text-xs text-white/70"
              title="Invite as"
            >
              <option value="MEMBER">Member</option>
              <option value="ADMIN">Admin</option>
            </select>
            <Button size="sm" onClick={handleAdd} disabled={busy || !email.trim()} className="h-8 rounded-full">
              Invite
            </Button>
          </div>
        )}

        <div className="max-h-80 space-y-1 overflow-y-auto">
          {members.map((m) => (
            <div key={m.id} className="flex items-center justify-between gap-2 rounded-lg px-2 py-2 hover:bg-white/5">
              <div className="min-w-0">
                <p className="truncate text-xs font-medium text-white/80">
                  {m.user.name || m.user.email}
                  {m.isSelf && <span className="ml-1 text-white/30">(you)</span>}
                </p>
                <p className="truncate text-[10px] text-white/30">{m.user.email}</p>
              </div>
              <div className="flex shrink-0 items-center gap-1.5">
                {canManage && !m.isSelf && m.role !== "OWNER" ? (
                  <select
                    value={m.role}
                    onChange={(e) => handleRole(m.id, e.target.value)}
                    className="h-7 rounded-md border border-white/10 bg-[#1a1a1a] px-1.5 text-[11px] text-white/70"
                  >
                    <option value="MEMBER">Member</option>
                    <option value="ADMIN">Admin</option>
                  </select>
                ) : (
                  <span className="rounded-full border border-white/10 px-2 py-0.5 text-[10px] text-white/50">
                    {m.role}
                  </span>
                )}
                {(canManage || m.isSelf) && (
                  <button
                    onClick={() => handleRemove(m.id, m.isSelf)}
                    className="rounded-md px-1.5 py-1 text-[11px] text-white/30 hover:bg-white/10 hover:text-red-400"
                    title={m.isSelf ? "Leave organization" : "Remove member"}
                  >
                    {m.isSelf ? "Leave" : "Remove"}
                  </button>
                )}
              </div>
            </div>
          ))}
          {members.length === 0 && (
            <p className="py-6 text-center text-xs text-white/25">No members found.</p>
          )}
        </div>

        {myRole === "OWNER" && orgId && (
          <div className="mt-3 border-t border-red-500/15 pt-3">
            <button
              onClick={handleDeleteOrg}
              className="w-full rounded-lg px-2 py-2 text-center text-[11px] text-red-400/70 hover:bg-red-500/10 hover:text-red-400"
            >
              Delete organization and all its projects
            </button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
