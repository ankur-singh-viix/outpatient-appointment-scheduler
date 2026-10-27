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
        {/* usePathname suspends on dynamic routes (cacheComponents), so the header needs a boundary. */}
        <Suspense fallback={<SiteHeaderFallback />}>
          <SiteHeader />
        </Suspense>
        <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-6 sm:py-8">{children}</main>
        <footer className="border-t bg-card py-5 text-center text-xs text-muted-foreground">
          CareSlot · Outpatient appointment scheduling demo
        </footer>
      </body>
    </html>
  );
}
