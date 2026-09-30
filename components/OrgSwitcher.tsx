"use client";

import { useRef, useState, useTransition } from "react";
import { usePathname, useRouter } from "next/navigation";
import { useClerk } from "@clerk/nextjs";
import { ChevronsUpDown, Check, Loader2, Plus } from "lucide-react";
import { toast } from "sonner";

interface OrgItem {
  id: string;
  name: string;
  role: string;
  credits: number;
  plan: string;
  clerkOrgId: string | null;
}

export function OrgSwitcher({ orgs, activeOrganizationId }: {
  orgs: OrgItem[];
  activeOrganizationId: string | null;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const clerk = useClerk();
  const { setActive } = clerk;
  const [open, setOpen] = useState(false);
  const [pendingName, setPendingName] = useState("");
  const [switching, startTransition] = useTransition();
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [createBusy, setCreateBusy] = useState(false);
  const inFlight = useRef(false);
  const current = orgs.find((org) => org.id === activeOrganizationId);

  const activateOrganization = async (organizationId: string, clerkOrgId: string | null, role: string) => {
    try {
      if (!clerkOrgId) throw new Error("Organization is not linked to Clerk yet.");
      await setActive({ organization: clerkOrgId });
      if (clerk.organization?.id !== clerkOrgId) throw new Error("Clerk did not activate the selected organization.");
    } catch (error) {
      if (role !== "OWNER") throw error;
      // Only the failed-activation path calls Clerk's Backend API. The server
      // verifies OWNER and repairs only missing setup / empty legacy orgs.
      const response = await fetch("/api/orgs/repair", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ organizationId }),
      });
      const result = await response.json();
      if (!response.ok || !result.clerkOrgId) throw new Error(result.message ?? "Could not repair organization access.");
      // Backend-added membership must also be visible to Clerk's client.
      await clerk.user?.reload();
      await setActive({ organization: result.clerkOrgId });
      if (clerk.organization?.id !== result.clerkOrgId) throw new Error("Clerk did not activate the selected organization.");
    }
  };

  const restoreActiveOrganization = async () => {
    if (!activeOrganizationId) return;
    try {
      const rollback = await fetch("/api/orgs/switch", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ organizationId: activeOrganizationId }),
      });
      if (!rollback.ok) throw new Error("Rollback failed");
    } catch {
      toast.error("Organization state could not be restored. Reload before continuing.");
      router.refresh();
    }
  };

  const handleSwitch = (org: OrgItem) => {
    if (inFlight.current || switching) return;
    setOpen(false);
    if (org.id === activeOrganizationId && org.clerkOrgId && org.clerkOrgId === clerk.organization?.id) return;
    inFlight.current = true;
    setPendingName(org.name);
    startTransition(async () => {
      let persisted = false;
      try {
        const response = await fetch("/api/orgs/switch", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ organizationId: org.id }),
        });
        const result = await response.json();
        if (!response.ok) throw new Error(result.message || "Could not switch organization.");
        persisted = true;
        await activateOrganization(org.id, result.clerkOrgId, org.role);
        // Clerk's Next.js provider refreshes the router after setActive.
        // A second refresh here duplicates the server render and DB reads.
        // A project editor belongs to its original org; leave it on a switch.
        if (pathname === "/workspace") router.push("/projects");
      } catch (error) {
        // Roll back the app pointer if Clerk activation failed, so billing and
        // project authorization don't silently use different organizations.
        if (persisted) await restoreActiveOrganization();
        toast.error(error instanceof Error ? error.message : "Could not switch organization.");
      } finally {
        inFlight.current = false;
      }
    });
  };

  const handleCreate = async () => {
    const name = newName.trim();
    if (!name || createBusy || inFlight.current) return;
    inFlight.current = true;
    setCreateBusy(true);
    let created = false;
    try {
      const response = await fetch("/api/orgs/create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      const result = await response.json().catch(() => null);
      if (!response.ok) throw new Error(result?.message ?? "Could not create organization.");
      created = true;
      await activateOrganization(result.organizationId, result.clerkOrgId, "OWNER");
      setOpen(false);
      setCreating(false);
      setNewName("");
      toast.success(`Created ${name}.`);
      // New orgs start empty; don't strand the user in another org's editor.
      // setActive already refreshes the route on success.
      if (pathname === "/workspace") router.push("/projects");
    } catch (error) {
      if (created) await restoreActiveOrganization();
      toast.error(created
        ? `Organization created, but could not activate it: ${error instanceof Error ? error.message : "Please try selecting it again."}`
        : error instanceof Error ? error.message : "Could not create organization.");
      // Show any saved org so setup can be retried without creating a duplicate.
      router.refresh();
    } finally {
      inFlight.current = false;
      setCreateBusy(false);
    }
  };

  return (
    <div className="relative" onBlur={(event) => {
      if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false);
    }} onKeyDown={(event) => { if (event.key === "Escape") setOpen(false); }}>
      <button
        disabled={switching || createBusy}
        aria-expanded={open}
        aria-controls="organization-options"
        aria-busy={switching}
        onClick={() => setOpen((value) => !value)}
        className="flex max-w-36 items-center gap-1.5 rounded-full border border-border bg-muted/50 px-3 py-1.5 text-xs text-foreground hover:bg-muted disabled:cursor-wait sm:max-w-48"
      >
        <span className="truncate" role="status">{switching ? `Switching to ${pendingName}…` : current?.name ?? "Organization"}</span>
        {switching ? <Loader2 className="h-3 w-3 shrink-0 animate-spin" /> : <ChevronsUpDown className="h-3 w-3 shrink-0 opacity-60" />}
      </button>
      {open && (
        <div id="organization-options" className="absolute right-0 z-50 mt-2 w-64 overflow-hidden rounded-xl border border-border bg-popover shadow-xl">
          {orgs.map((org) => (
            <button key={org.id} disabled={switching || createBusy} onClick={() => handleSwitch(org)}
              aria-current={org.id === activeOrganizationId ? "true" : undefined}
              className="flex w-full items-center justify-between px-3 py-2.5 text-left hover:bg-muted focus-visible:bg-muted">
              <span className="min-w-0">
                <span className="block truncate text-xs font-medium text-foreground">{org.name}</span>
                <span className="block text-[10px] text-muted-foreground">{org.role} · {org.credits} credits</span>
              </span>
              {org.id === activeOrganizationId && <Check className="h-3.5 w-3.5 shrink-0 text-violet-500" />}
            </button>
          ))}
          <div className="border-t border-border p-2">
            {creating ? (
              <div className="space-y-2 px-1 py-1">
                <input
                  autoFocus
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") void handleCreate();
                  }}
                  placeholder="Organization name"
                  maxLength={60}
                  aria-label="New organization name"
                  className="h-8 w-full rounded-lg border border-border bg-muted/50 px-2.5 text-xs text-foreground placeholder:text-muted-foreground focus-visible:outline-ring"
                />
                <div className="flex justify-end gap-1.5">
                  <button
                    onClick={() => {
                      setCreating(false);
                      setNewName("");
                    }}
                    disabled={createBusy}
                    className="rounded-full px-2.5 py-1 text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-40"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={handleCreate}
                    disabled={createBusy || !newName.trim()}
                    className="rounded-full bg-violet-500 px-3 py-1 text-[11px] font-semibold text-white hover:bg-violet-400 disabled:opacity-40"
                  >
                    {createBusy ? "Creating…" : "Create"}
                  </button>
                </div>
              </div>
            ) : (
              <button
                onClick={() => setCreating(true)}
                disabled={switching || createBusy}
                className="flex w-full items-center gap-1.5 rounded-lg px-3 py-2 text-left text-xs font-medium text-muted-foreground hover:bg-muted hover:text-foreground"
              >
                <Plus className="h-3.5 w-3.5" />
                New organization
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
