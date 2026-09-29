"use client";

import React, { Suspense, useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import {
  SignIn,
  SignUp,
  useOrganizationList,
  useSignIn,
  useUser,
} from "@clerk/nextjs";
import { Loader2 } from "lucide-react";

/**
 * AcceptInvitationContent
 *
 * Handles all three cases Clerk sends when a user clicks an invitation link
 * (see https://clerk.com/docs/guides/development/custom-flows/organizations/accept-organization-invitations):
 *
 *  __clerk_status=sign_up   → New user: render <SignUp>, which auto-consumes
 *                             the __clerk_ticket and creates the account.
 *
 *  __clerk_status=sign_in   → Existing user, not signed in: render <SignIn>,
 *                             which auto-consumes the ticket. If they happen to
 *                             be signed in already, fall through to the ticket
 *                             consumption below.
 *
 *  __clerk_status=complete  → User is already signed in. Despite what the name
 *                             suggests, the invitation is NOT guaranteed to be
 *                             consumed — in practice the invite can stay
 *                             "pending" unless we explicitly accept it. So we
 *                             load the user's pending organization invitations
 *                             and call accept() on the first one before
 *                             redirecting to /projects. If the list loads empty
 *                             (already accepted elsewhere), we just redirect.
 *
 * In every case the final destination is /projects. Webhook + on-demand sync
 * heal the Prisma membership afterwards, so errors here never block the user:
 * we always redirect, at latest via the safety timeout.
 *
 * Note: @clerk/nextjs v7 uses a signals-based API:
 *   useSignIn() → { signIn, errors, fetchStatus }  (no isLoaded)
 *   signIn.ticket({ ticket }) → Promise<{ error: ClerkError | null }>
 */
function AcceptInvitationContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { isLoaded: userLoaded, isSignedIn } = useUser();
  // v7 signals-based hook — no isLoaded, readiness via fetchStatus.
  const { signIn, fetchStatus } = useSignIn();
  const { isLoaded: orgListLoaded, userInvitations } = useOrganizationList({
    userInvitations: true,
  });

  const status = searchParams.get("__clerk_status");
  const ticket = searchParams.get("__clerk_ticket");

  type Phase =
    | "loading"
    | "accepting"
    | "redirecting"
    | "show_sign_in"
    | "show_sign_up";
  const [phase, setPhase] = useState<Phase>("loading");
  const finished = useRef(false);

  const redirectToProjects = React.useCallback(() => {
    if (finished.current) return;
    finished.current = true;
    setPhase("redirecting");
    router.replace("/projects");
  }, [router]);

  // Safety net: never strand the user on this page. If nothing resolves the
  // flow within 12s (slow invitation fetch, expired ticket, …), redirect —
  // webhook + manual sync heal membership server-side.
  useEffect(() => {
    const t = setTimeout(() => {
      if (!finished.current) {
        console.warn("[accept-invitation] safety timeout — redirecting");
        redirectToProjects();
      }
    }, 12000);
    return () => clearTimeout(t);
  }, [redirectToProjects]);

  useEffect(() => {
    // Wait until auth state and the ticket hook are settled.
    if (!userLoaded || fetchStatus === "fetching") return;
    if (finished.current) return;

    async function run() {
      // ── Signed in ────────────────────────────────────────────────────
      if (isSignedIn) {
        // No ticket (stray visit): nothing to consume.
        if (!ticket) {
          redirectToProjects();
          return;
        }

        // status=complete (or unknown status): the user is signed in, so
        // consume any still-pending invitation explicitly instead of assuming
        // Clerk already did it.
        if (status === "complete" || !status) {
          // Wait for the invitations list — orgListLoaded + !isLoading is the
          // sanctioned gate (data may be an empty array before the fetch
          // resolves, so neither flag alone is sufficient).
          if (!orgListLoaded || userInvitations.isLoading) {
            return; // effect re-runs when the flags flip
          }
          const pending = (userInvitations.data ?? []).filter(
            (inv) => inv.status === "pending"
          );
          if (pending.length > 0) {
            setPhase("accepting");
            try {
              await pending[0].accept();
            } catch (err) {
              // Already accepted/revoked/expired — redirect anyway.
              console.warn("[accept-invitation] accept() failed:", err);
            }
          }
          redirectToProjects();
          return;
        }

        // status=sign_in/sign_up but a session already exists (e.g. clicked
        // while logged in as a different account, or session settled first).
        // Try the ticket flow for the current session, then redirect.
        if (signIn) {
          try {
            setPhase("accepting");
            const result = await signIn.ticket({ ticket });
            if (result.error) {
              console.warn(
                "[accept-invitation] ticket error (wrong account, already a member, or expired?):",
                result.error
              );
            }
          } catch (err) {
            console.warn("[accept-invitation] ticket sign-in threw:", err);
          }
        }
        redirectToProjects();
        return;
      }

      // ── Not signed in: let the prebuilt components consume the ticket ──
      if (status === "sign_up") {
        setPhase("show_sign_up");
      } else {
        setPhase("show_sign_in");
      }
    }

    run();
  }, [
    userLoaded,
    fetchStatus,
    isSignedIn,
    status,
    ticket,
    router,
    signIn,
    orgListLoaded,
    userInvitations.isLoading,
    userInvitations.data,
    redirectToProjects,
  ]);

  if (phase === "loading" || phase === "accepting") {
    return (
      <div className="flex flex-col items-center justify-center gap-3 py-16 text-center text-white/70">
        <Loader2 className="h-6 w-6 animate-spin text-white/50" />
        <p className="text-sm font-medium">
          {phase === "accepting" ? "Accepting invitation..." : "Loading..."}
        </p>
      </div>
    );
  }

  if (phase === "redirecting") {
    return (
      <div className="flex flex-col items-center justify-center gap-3 py-16 text-center text-white/70">
        <Loader2 className="h-6 w-6 animate-spin text-white/50" />
        <p className="text-sm font-medium">Redirecting to your projects...</p>
      </div>
    );
  }

  if (phase === "show_sign_up") {
    return (
      <SignUp
        path="/accept-invitation"
        routing="path"
        fallbackRedirectUrl="/projects"
        signInUrl="/sign-in"
      />
    );
  }

  return (
    <SignIn
      path="/accept-invitation"
      routing="path"
      fallbackRedirectUrl="/projects"
      signUpUrl="/sign-up"
    />
  );
}

export default function AcceptInvitationPage() {
  return (
    <Suspense
      fallback={
        <div className="flex flex-col items-center justify-center gap-3 py-16 text-white/50">
          <Loader2 className="h-6 w-6 animate-spin" />
          <p className="text-sm">Loading invitation...</p>
        </div>
      }
    >
      <AcceptInvitationContent />
    </Suspense>
  );
}
