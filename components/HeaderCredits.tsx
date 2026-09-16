"use client";

import { useEffect, useState } from "react";
import { Zap } from "lucide-react";
import { PricingModal } from "@/components/PricingModal";
import { subscribeCredits } from "@/lib/credits-bus";

export function HeaderCredits({ initial }: { initial: number }) {
  const [credits, setCredits] = useState(initial);
  const [prevInitial, setPrevInitial] = useState(initial);

  // Server rendered a new value (e.g. after navigation) - adopt it.
  if (prevInitial !== initial) {
    setPrevInitial(initial);
    setCredits(initial);
  }

  // Live updates from WorkspaceClient (optimistic -1 on submit, authoritative on done)
  useEffect(() => subscribeCredits(setCredits), []);

  return (
    <PricingModal>
      <span className="inline-flex h-8 items-center gap-1.5 rounded-full border border-white/10 bg-white/5 px-3 text-xs text-white/70">
        <Zap className="h-3 w-3 fill-white/70" />
        {credits} credits
      </span>
    </PricingModal>
  );
}
