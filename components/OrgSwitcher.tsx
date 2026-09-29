"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useClerk } from "@clerk/nextjs";
import { ChevronsUpDown, Check } from "lucide-react";

interface OrgItem {
  id: string;
  name: string;
  role: string;
  credits: number;
  plan: string;
  clerkOrgId: string | null;
}

export function OrgSwitcher({ currentName }: { currentName: string | null }) {
  const router = useRouter();
  const { setActive } = useClerk();
  const [orgs, setOrgs] = useState<OrgItem[]>([]);
  const [open, setOpen] = useState(false);
  const [switching, setSwitching] = useState(false);

  useEffect(() => {
    fetch("/api/orgs")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (d?.orgs) setOrgs(d.orgs);
      })
      .catch(() => {});
  }, []);

  if (orgs.length <= 1) {
    return currentName ? (
      <span className="max-w-40 truncate text-[13px] font-medium text-white/60">
        {currentName}
      </span>
    ) : null;
  }

  const handleSwitch = async (id: string) => {
    setSwitching(true);
    try {
      const res = await fetch("/api/orgs/switch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ organizationId: id }),
      });
      if (!res.ok) return;
      const d = (await res.json().catch(() => null)) as {
        clerkOrgId?: string | null;
      } | null;
      // Keep Clerk's active org in lockstep so org checkout bills correctly.
      if (d?.clerkOrgId) {
        try {
          await setActive({ organization: d.clerkOrgId });
        } catch {
          // Org not linked in Clerk yet — Prisma pointer still switched.
        }
      }
      setOpen(false);
      router.refresh();
    } finally {
      setSwitching(false);
    }
  };

  return (
    <div className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex max-w-44 items-center gap-1.5 rounded-full border border-white/10 bg-white/5 px-3 py-1.5 text-xs text-white/70 hover:bg-white/10"
      >
        <span className="truncate">{currentName ?? "Organization"}</span>
        <ChevronsUpDown className="h-3 w-3 shrink-0 opacity-60" />
      </button>
      {open && (
        <div className="absolute right-0 z-50 mt-2 w-64 overflow-hidden rounded-xl border border-white/10 bg-[#111] shadow-xl">
          {orgs.map((o) => (
            <button
              key={o.id}
              disabled={switching}
              onClick={() => handleSwitch(o.id)}
              className="flex w-full items-center justify-between px-3 py-2.5 text-left hover:bg-white/5"
            >
              <span>
                <span className="block truncate text-xs font-medium text-white/80">
                  {o.name}
                </span>
                <span className="block text-[10px] text-white/30">
                  {o.role} · {o.credits} credits
                </span>
              </span>
              {o.name === currentName && (
                <Check className="h-3.5 w-3.5 text-violet-400" />
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
