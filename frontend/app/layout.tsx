import { ClerkProvider } from "@clerk/nextjs";
import type { Metadata } from "next";
import { Geist } from "next/font/google";
import type { ReactNode } from "react";
import { Suspense } from "react";
import { ClerkAuthBridge } from "@/components/clerk-auth-bridge";
import { Sidebar } from "@/components/sidebar";
import { SiteHeader, SiteHeaderFallback } from "@/components/site-header";
import { CLERK_ENABLED } from "@/lib/clerk-config";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "CareSlot · Book doctor appointments",
  description: "Find a doctor, pick a time that suits you and book an outpatient appointment.",
};

function Shell({ children }: { children: ReactNode }) {
  return (
    <>
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
      <div className="flex flex-1">
        {/* Shows only for signed-in users with a workspace; for everyone else the page uses the full width. */}
        <Suspense fallback={null}>
          <Sidebar />
        </Suspense>
        <main id="main" className="min-w-0 flex-1">
          <div className="mx-auto w-full max-w-6xl px-4 py-6 sm:py-8">{children}</div>
        </main>
      </div>
      <footer className="border-t bg-card py-6 text-center text-xs text-muted-foreground">
        <p className="font-medium text-foreground/80">CareSlot</p>
        <p className="mt-1">Outpatient appointment scheduling · demo environment, not for real medical use</p>
      </footer>
    </>
  );
}

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${geistSans.variable} h-full antialiased`}>
      <body className="flex min-h-full flex-col">
        {CLERK_ENABLED ? (
          // Clerk's provider sits inside <body>. It is only used when a publishable key is configured.
          <ClerkProvider
            signInUrl="/login"
            signUpUrl="/signup"
            afterSignOutUrl="/"
            appearance={{ variables: { colorPrimary: "#00796b", borderRadius: "0.625rem" } }}
          >
            <ClerkAuthBridge />
            <Shell>{children}</Shell>
          </ClerkProvider>
        ) : (
          <Shell>{children}</Shell>
        )}
      </body>
    </html>
  );
}
