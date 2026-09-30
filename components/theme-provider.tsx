"use client";

import * as React from "react";
import { ThemeProvider as NextThemesProvider, useTheme } from "next-themes";
import { ClerkProvider } from "@clerk/nextjs";
import { dark } from "@clerk/themes";

function ThemedClerkProvider({ children }: { children: React.ReactNode }) {
  const { resolvedTheme } = useTheme();
  return <ClerkProvider appearance={{ theme: resolvedTheme === "light" ? undefined : dark }}>{children}</ClerkProvider>;
}

export function ThemeProvider({
  children,
  ...props
}: React.ComponentProps<typeof NextThemesProvider>) {
  return <NextThemesProvider {...props}><ThemedClerkProvider>{children}</ThemedClerkProvider></NextThemesProvider>;
}
