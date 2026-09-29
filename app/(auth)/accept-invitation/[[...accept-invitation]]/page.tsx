"use client";

import React, { Suspense, useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { SignIn, SignUp, useSignIn, useUser } from "@clerk/nextjs";
import { Loader2 } from "lucide-react";

/**
 * AcceptInvitationContent
 *
 * Handles all three cases Clerk sends when a user clicks an invitation link:
 *
 *  __clerk_status=sign_up   → New user: render <SignUp> which auto-consumes the
 *                             __clerk_ticket and creates+signs-in the account.
 *
 *  __clerk_status=sign_in   → Existing user who is NOT currently signed in:
 *                             render <SignIn> which auto-consumes the ticket.
 *
 *  __clerk_status=complete  → User is ALREADY signed in (current session).
 *                             Clerk has already added them to the org on the
 *                             backend. Just redirect to /projects.
 *
 * If the user is signed in but status is "sign_in" (e.g. they clicked the link
 * while logged in as a different account), we use signIn.ticket() to consume
 * the ticket for the current session and join the org.
 *
 * In every case the final destination is /projects.
 *
 * Note: @clerk/nextjs v7 uses a signals-based API:
 *   useSignIn() → { signIn, errors, fetchStatus }  (no isLoaded)
 *   signIn.ticket({ ticket }) → Promise<{ error: ClerkError | null }>
 */
function AcceptInvitationContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { isLoaded: userLoaded, isSignedIn } = useUser();
  // v7 signals-based hook — no isLoaded, use fetchStatus or just check signIn existence
  const { signIn, fetchStatus } = useSignIn();

  const status = searchParams.get("__clerk_status");
  const ticket = searchParams.get("__clerk_ticket");

  type Phase = "loading" | "accepting" | "redirecting" | "show_sign_in" | "show_sign_up";
  const [phase, setPhase] = useState<Phase>("loading");
  const ran = useRef(false);

  useEffect(() => {
    // Wait for useUser to be ready and signIn hook to be idle (not fetching)
    if (!userLoaded || fetchStatus === "fetching") return;
    if (ran.current) return;
    ran.current = true;

    async function run() {
      if (isSignedIn) {
        // status=complete: Clerk already added them — just redirect.
        if (status === "complete" || !ticket) {
          setPhase("redirecting");
          router.replace("/projects");
          return;
        }

        // status=sign_in but user is already signed in.
        // Consume the ticket to join the org for the current session, then redirect.
        if (signIn) {
          try {
            setPhase("accepting");
            const result = await signIn.ticket({ ticket: ticket! });
            if (result.error) {
              console.warn(
                "[accept-invitation] ticket sign-in error (already a member or expired?):",
                result.error
              );
            }
          } catch (err) {
            console.warn("[accept-invitation] ticket sign-in threw:", err);
          }
        }
        setPhase("redirecting");
        router.replace("/projects");
        return;
      }

      // Not signed in — show the appropriate Clerk component.
      if (status === "sign_up") {
        setPhase("show_sign_up");
      } else {
        setPhase("show_sign_in");
      }
    }

    run();
  }, [userLoaded, fetchStatus, isSignedIn, status, ticket, router, signIn]);

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
