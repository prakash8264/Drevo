"use client";

const EVENT = "drevo:credits";

export function emitCredits(credits: number) {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent<number>(EVENT, { detail: credits }));
}

export function subscribeCredits(cb: (credits: number) => void) {
  if (typeof window === "undefined") return () => {};
  const handler = (e: Event) => {
    cb((e as CustomEvent<number>).detail);
  };
  window.addEventListener(EVENT, handler);
  return () => window.removeEventListener(EVENT, handler);
}
