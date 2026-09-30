"use client";

import { useRef, useState } from "react";
import { useAuth, useClerk } from "@clerk/nextjs";
import { CheckoutButton } from "@clerk/nextjs/experimental";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";

export function OrganizationCheckoutButton({ planId, className, children }: {
  planId: string;
  className?: string;
  children: React.ReactNode;
}) {
  const { orgId } = useAuth();
  const clerk = useClerk();
  const trigger = useRef<HTMLButtonElement>(null);
  const inFlight = useRef(false);
  const [checking, setChecking] = useState(false);

  const handleCheckout = async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setChecking(true);
    try {
      const response = await fetch("/api/orgs/billing/checkout", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clerkOrgId: clerk.organization?.id ?? null }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.message ?? "Could not verify the checkout organization.");
      // Re-read Clerk after the request: switching during preflight must not
      // open checkout for a different payer than the server just authorized.
      if (!result.clerkOrgId || clerk.organization?.id !== result.clerkOrgId || !trigger.current) {
        throw new Error("Organization changed. Please select it again before upgrading.");
      }
      trigger.current.click();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not verify the checkout organization.");
    } finally {
      inFlight.current = false;
      setChecking(false);
    }
  };

  return (
    <>
      <Button variant="ghost" className={className} disabled={checking} aria-busy={checking} onClick={handleCheckout}>
        {children}
      </Button>
      {orgId && (
        <CheckoutButton planId={planId} planPeriod="month" for="organization" checkoutProps={{
          appearance: { elements: { drawerRoot: { zIndex: 2000 } } },
        }}>
          {/* Keep Clerk's supported trigger; only click it after preflight. */}
          <button ref={trigger} type="button" hidden tabIndex={-1} aria-hidden="true" />
        </CheckoutButton>
      )}
    </>
  );
}
