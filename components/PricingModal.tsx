"use client";

import { useEffect, useState } from "react";
import { useAuth, SignInButton } from "@clerk/nextjs";
import { CheckoutButton } from "@clerk/nextjs/experimental";
import { ArrowRight, Check } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogTrigger,
} from "@/components/ui/dialog";
import { BrandTitle, GrayTitle } from "./reusables";
import { PRICING_PLANS } from "@/lib/constants";

interface PricingModalProps {
  children: React.ReactNode;
  reason?: "credits" | "upgrade";
  // Organization plan is the source of truth (free|starter|pro), synced from
  // the Clerk org subscription via /api/webhooks/clerk. Checkout below bills
  // the ACTIVE Clerk org (for="organization") — the switcher must keep the
  // Clerk active org and Prisma activeOrganizationId in sync. The has()
  // fallback is display-only for orgs not yet webhook-synced.
  // Only the org OWNER can buy: pass orgRole from the server header when
  // available; otherwise the modal resolves it via /api/orgs/members.
  orgPlan?: string | null;
  orgRole?: string | null;
}

export function PricingModal({
  children,
  reason = "upgrade",
  orgPlan = null,
  orgRole = null,
}: PricingModalProps) {
  const { isSignedIn, has } = useAuth();
  // Server-known role wins when provided (header path); otherwise resolve
  // the caller's active-org role once when signed in (e.g. ChatPanel).
  const [fetchedRole, setFetchedRole] = useState<string | null>(null);

  // Fallback for callers without server role context (e.g. ChatPanel):
  // resolve the caller's role in the active org once when signed in.
  useEffect(() => {
    if (!isSignedIn || orgRole) return;
    let cancelled = false;
    fetch("/api/orgs/members")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!cancelled && d?.role) setFetchedRole(d.role);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [isSignedIn, orgRole]);

  const resolvedRole = orgRole ?? fetchedRole;

  // Role unknown yet (still resolving): treat paid checkout as unavailable
  // rather than flashing an Upgrade button to non-owners.
  const canBuy = resolvedRole === "OWNER";

  const title =
    reason === "credits" ? "You're out of credits" : "Upgrade your plan";
  const description =
    reason === "credits"
      ? "You've used all your credits. Upgrade to keep building."
      : "Choose a plan that fits how much you build.";

  const planOrder: Record<string, number> = {
    free: 0,
    starter: 1,
    pro: 2,
  };

  const activePlanKey = orgPlan ?? (isSignedIn
    ? has?.({ plan: "pro" }) || has?.({ plan: "proorg" })
      ? "pro"
      : has?.({ plan: "starter" }) || has?.({ plan: "starterorg" })
      ? "starter"
      : "free"
    : null);

  return (
    <Dialog>
      <DialogTrigger className={"cursor-pointer"}>{children}</DialogTrigger>
      <DialogContent className="border-border bg-popover p-0 text-popover-foreground sm:max-w-5xl max-h-[90dvh] overflow-y-auto">
        <DialogHeader className="px-6 pt-6 pb-2">
          <DialogTitle className="font-serif text-xl tracking-tight text-foreground">
            <BrandTitle className="text-4xl">{title}</BrandTitle>
          </DialogTitle>
          <DialogDescription className="text-sm text-muted-foreground">
            {description}
          </DialogDescription>
        </DialogHeader>

        <div className="grid grid-cols-1 gap-3 px-6 pb-6 sm:grid-cols-3">
          {PRICING_PLANS.map((plan) => {
            const isActive = isSignedIn && activePlanKey === plan.key;
            const isDowngrade =
              isSignedIn &&
              activePlanKey !== null &&
              !isActive &&
              planOrder[plan.key] < planOrder[activePlanKey];

            return (
              <div
                key={plan.key}
                className={cn(
                  "relative flex flex-col rounded-2xl border p-5 transition-colors",
                  plan.featured
                    ? "border-violet-500/50 bg-violet-500/4"
                    : "border-border bg-background"
                )}
              >
                {/* Most popular pill */}
                {plan.featured && (
                  <div className="absolute -top-3 left-1/2 -translate-x-1/2">
                    <span className="rounded-full border border-violet-500/20 bg-background px-3 py-1 text-[11px] font-medium text-violet-500">
                      Most popular
                    </span>
                  </div>
                )}

                {/* Plan name + active badge */}
                <div className="mb-1 flex items-center gap-2">
                  <p className="text-sm font-semibold text-foreground">
                    {plan.label}
                  </p>
                  {isActive && (
                    <span className="rounded-full border border-violet-500/20 bg-violet-500/10 px-2 py-0.5 text-[10px] font-medium text-violet-400">
                      Active
                    </span>
                  )}
                </div>

                {/* Description */}
                <p className="mb-6 text-xs leading-relaxed text-muted-foreground">
                  {plan.description}
                </p>

                {/* Price */}
                <div className="mb-1 flex items-baseline gap-1">
                  <span className="font-serif text-4xl">
                    {plan.price === 0 ? (
                      <GrayTitle>$0</GrayTitle>
                    ) : (
                      <BrandTitle>${plan.price}</BrandTitle>
                    )}
                  </span>
                  {plan.price > 0 && (
                    <span className="text-sm text-muted-foreground">/mo</span>
                  )}
                </div>
                <p className="mb-6 text-xs text-muted-foreground">
                  {plan.price === 0 ? "Always free" : "Only billed monthly"}
                </p>

                {/* Feature list */}
                <div className="mb-8 space-y-3 border-t border-border pt-6">
                  {plan.features.map((f) => (
                    <div key={f} className="flex items-center gap-2.5">
                      <div
                        className={cn(
                          "flex h-4 w-4 shrink-0 items-center justify-center rounded-full",
                          plan.featured ? "bg-violet-500/15" : "bg-muted"
                        )}
                      >
                        <Check
                          className={cn(
                            "h-2.5 w-2.5",
                            plan.featured ? "text-violet-500" : "text-muted-foreground"
                          )}
                        />
                      </div>
                      <span className="text-xs text-muted-foreground">{f}</span>
                    </div>
                  ))}
                </div>

                {/* CTA button */}
                <div className="mt-auto">
                  {isActive ? (
                    <Button
                      disabled
                      className="w-full rounded-full text-sm font-semibold opacity-50 cursor-not-allowed border border-border bg-transparent text-muted-foreground"
                      variant="ghost"
                    >
                      ✓ Current plan
                    </Button>
                  ) : plan.price === 0 ? (
                    isSignedIn ? (
                      <Button
                        disabled
                        className="w-full rounded-full text-sm font-semibold opacity-50 cursor-not-allowed border border-border bg-transparent text-muted-foreground"
                        variant="ghost"
                      >
                        Default plan
                      </Button>
                    ) : (
                      <SignInButton mode="modal">
                        <Button
                          className="w-full rounded-full text-sm font-semibold border border-border bg-transparent text-muted-foreground hover:bg-muted hover:text-foreground"
                          variant="ghost"
                        >
                          Get started free
                          <ArrowRight className="h-3.5 w-3.5" />
                        </Button>
                      </SignInButton>
                    )
                  ) : isSignedIn ? (
                    canBuy ? (
                      <CheckoutButton
                        planId={plan.planId}
                        planPeriod="month"
                        for="organization"
                        checkoutProps={{
                          appearance: {
                            elements: {
                              drawerRoot: {
                                zIndex: 2000,
                              },
                            },
                          },
                        }}
                      >
                        <Button
                          className={cn(
                            "w-full rounded-full text-sm font-semibold transition-all",
                            plan.featured
                              ? "bg-violet-500 text-white hover:bg-violet-400 active:scale-95"
                              : "border border-border bg-transparent text-muted-foreground hover:bg-muted hover:text-foreground"
                          )}
                          variant="ghost"
                        >
                          {isDowngrade ? "Downgrade" : "Upgrade"}
                          <ArrowRight className="h-3.5 w-3.5" />
                        </Button>
                      </CheckoutButton>
                    ) : (
                      <Button
                        disabled
                        title="Only the organization owner can change the plan"
                        className="w-full rounded-full text-sm font-semibold opacity-50 cursor-not-allowed border border-border bg-transparent text-muted-foreground"
                        variant="ghost"
                      >
                        Owner-only
                      </Button>
                    )
                  ) : (
                    <SignInButton mode="modal">
                      <Button
                        className={cn(
                          "w-full rounded-full text-sm font-semibold transition-all",
                          plan.featured
                            ? "bg-violet-500 text-white hover:bg-violet-400 active:scale-95"
                            : "border border-border bg-transparent text-muted-foreground hover:bg-muted hover:text-foreground"
                        )}
                        variant="ghost"
                      >
                        Upgrade
                        <ArrowRight className="h-3.5 w-3.5" />
                      </Button>
                    </SignInButton>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </DialogContent>
    </Dialog>
  );
}
