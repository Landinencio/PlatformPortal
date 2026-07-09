import type { Metadata } from "next";
import { IBM_Plex_Sans, Sora } from "next/font/google";
import "./globals.css";
import { Providers } from "@/components/providers";
import { ConditionalShell } from "@/components/conditional-shell";
import { CommandPalette } from "@/components/command-palette";
import { cn } from "@/lib/utils";

const plex = IBM_Plex_Sans({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-sans",
});

const sora = Sora({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-display",
});

export const metadata: Metadata = {
  title: "DevPortal | IskayPet",
  description: "Internal Developer Portal for IskayPet",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: `try{const t=localStorage.getItem("theme");const d=t==="dark"||(t==null&&matchMedia("(prefers-color-scheme:dark)").matches);if(d)document.documentElement.classList.add("dark")}catch(e){}` }} />
      </head>
      <body className={cn(plex.variable, sora.variable, "min-h-screen bg-background font-sans antialiased")}>
        <Providers>
          <ConditionalShell>
            {children}
          </ConditionalShell>
          <CommandPalette />
        </Providers>
      </body>
    </html>
  );
}
