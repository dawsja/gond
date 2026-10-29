import type { Metadata, Viewport } from "next";
import { Inter, JetBrains_Mono } from "next/font/google";
import { headers } from "next/headers";
import { ThemeProvider } from "@/components/theme-provider";
import { Toaster } from "@/components/ui/toast";
import { TooltipProvider } from "@/components/ui/tooltip";
import { appScale, THEME_INIT_SCRIPT } from "@/lib/theme/theme";
import "./globals.css";

const inter = Inter({ variable: "--font-inter", subsets: ["latin"], weight: ["400", "500", "600", "700"] });
const jetbrains = JetBrains_Mono({ variable: "--font-jetbrains", subsets: ["latin"], weight: ["400", "500", "600"] });

export const metadata: Metadata = {
  title: { default: "Gond", template: "%s · Gond" },
  description: "Your team of always-on AI bots, each with its own computer. Self-hosted and open source.",
  applicationName: "Gond",
  robots: { index: false, follow: false },
  icons: { icon: "/favicon.ico", apple: "/logo.png" },
  manifest: "/manifest.webmanifest",
  appleWebApp: { capable: true, title: "Gond", statusBarStyle: "default" },
};

const VIEWPORT: Viewport = {
  colorScheme: "light dark",
  userScalable: false,
  viewportFit: "cover",
  interactiveWidget: "resizes-content",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f5f3ee" },
    { media: "(prefers-color-scheme: dark)", color: "#121212" },
  ],
};

// The phone apps' pages arrive zoomed (`appScale`): with no width, the viewport is the screen's
// width over the scale, so the page is laid out at that size from its first byte. Next fills in
// width=device-width unless the key is there, undefined.
export async function generateViewport(): Promise<Viewport> {
  const scale = appScale((await headers()).get("user-agent"));
  if (scale === 1) return { ...VIEWPORT, width: "device-width", initialScale: 1, maximumScale: 1 };
  return { ...VIEWPORT, width: undefined, initialScale: scale, minimumScale: scale, maximumScale: scale };
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${inter.variable} ${jetbrains.variable} h-full antialiased`} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
      </head>
      <body className="flex min-h-full flex-col bg-background font-sans text-foreground">
        <ThemeProvider>
          <TooltipProvider>
            <Toaster>{children}</Toaster>
          </TooltipProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
