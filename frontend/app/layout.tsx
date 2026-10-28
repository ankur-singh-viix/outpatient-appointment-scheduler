import type { Metadata } from "next";
import { Geist } from "next/font/google";
import { Suspense } from "react";
import { SiteHeader, SiteHeaderFallback } from "@/components/site-header";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "CareSlot · Book doctor appointments",
  description: "Find a doctor, pick a time that suits you and book an outpatient appointment.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${geistSans.variable} h-full antialiased`}>
      <body className="flex min-h-full flex-col">
        <a
          href="#main"
          className="sr-only rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground focus:not-sr-only focus:fixed focus:top-3 focus:left-3 focus:z-50"
        >
          Skip to content
        </a>
        {/* usePathname suspends on dynamic routes (cacheComponents), so the header needs a boundary. */}
        <Suspense fallback={<SiteHeaderFallback />}>
          <SiteHeader />
        </Suspense>
        <main id="main" className="mx-auto w-full max-w-6xl flex-1 px-4 py-6 sm:py-8">
          {children}
        </main>
        <footer className="border-t bg-card py-6 text-center text-xs text-muted-foreground">
          <p className="font-medium text-foreground/80">CareSlot</p>
          <p className="mt-1">Outpatient appointment scheduling · demo environment, not for real medical use</p>
        </footer>
      </body>
    </html>
  );
}
