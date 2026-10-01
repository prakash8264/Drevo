"use client";

import { useEffect, useState } from "react";
import { Zap } from "lucide-react";
import { PricingModal } from "@/components/PricingModal";
import { subscribeCredits } from "@/lib/credits-bus";

export function HeaderCredits({ initial, orgId, orgPlan = null, orgRole = null }: { initial: number; orgId: string; orgPlan?: string | null; orgRole?: string | null }) {
  const [credits, setCredits] = useState(initial);
  const [prevInitial, setPrevInitial] = useState(initial);

  // Server rendered a new value (e.g. after navigation) - adopt it.
  if (prevInitial !== initial) {
    setPrevInitial(initial);
    setCredits(initial);
  }

  // Live updates from WorkspaceClient (optimistic -1 on submit, authoritative on done)
  useEffect(() => subscribeCredits(orgId, setCredits), [orgId]);

  return (
    <PricingModal orgPlan={orgPlan} orgRole={orgRole}>
      <span className="inline-flex h-8 items-center gap-1.5 rounded-full border border-border bg-muted/50 px-3 text-xs text-foreground">
        <Zap className="h-3 w-3 fill-current" />
        {credits} credits
      </span>
    </PricingModal>
  );
}
