"use client";

const EVENT = "drevo:credits";

export function emitCredits(credits: number, orgId: string) {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(EVENT, { detail: { credits, orgId } }));
}

export function subscribeCredits(orgId: string, cb: (credits: number) => void) {
  if (typeof window === "undefined") return () => {};
  const handler = (e: Event) => {
    const detail = (e as CustomEvent<{ credits: number; orgId: string }>).detail;
    if (detail.orgId === orgId) cb(detail.credits);
  };
  window.addEventListener(EVENT, handler);
  return () => window.removeEventListener(EVENT, handler);
}
