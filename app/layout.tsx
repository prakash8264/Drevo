import type { Metadata, Viewport } from "next";
import { DM_Sans, Lora } from "next/font/google";
import "./globals.css";
import { ClerkProvider } from "@clerk/nextjs";
import Header from "@/components/Header";
import { dark } from "@clerk/themes";
import { ThemeProvider } from "@/components/theme-provider";
import { Toaster } from "@/components/ui/sonner";

const lora = Lora({
  subsets: ["latin"],
  weight: ["400", "500"],
  style: ["normal", "italic"],
  variable: "--font-serif",
});

const dmSans = DM_Sans({
  subsets: ["latin"],
  weight: ["300", "400", "500", "600"],
  variable: "--font-sans",
});

export const metadata: Metadata = {
  title: "Drevo — Dream it. Develop it.",
  description:
    "Drevo turns your ideas into working React apps. Describe what you want to build — AI writes the code and renders a live preview in your browser.",
  icons: {
    icon: "/logo-short.png",
  },
  openGraph: {
    title: "Drevo — Dream it. Develop it.",
    description:
      "Prompt-to-app builder: describe your idea, get a working React app with live preview.",
    type: "website",
  },
  twitter: {
    card: "summary",
    title: "Drevo — Dream it. Develop it.",
    description:
      "Prompt-to-app builder: describe your idea, get a working React app with live preview.",
  },
};

export const viewport: Viewport = {
  themeColor: "#0a0a0a",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <ClerkProvider
      appearance={{
        theme: dark,
      }}
    >
      <html lang="en" suppressHydrationWarning>
        <body className={`${lora.variable} ${dmSans.variable} font-sans`}>
          <ThemeProvider
            attribute="class"
            defaultTheme="system"
            enableSystem
            disableTransitionOnChange
          >
            <Header />

            <main>{children}</main>

            <Toaster richColors />
          </ThemeProvider>
        </body>
      </html>
    </ClerkProvider>
  );
}