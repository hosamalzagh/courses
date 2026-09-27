import type { Metadata } from "next";
import { cookies } from "next/headers";
import localFont from "next/font/local";
import { ThemeProvider } from "@/components/ThemeProvider";
import "./globals.css";

const arabic = localFont({
  src: [
    { path: "../node_modules/@fontsource/ibm-plex-sans-arabic/files/ibm-plex-sans-arabic-arabic-400-normal.woff2", weight: "400" },
    { path: "../node_modules/@fontsource/ibm-plex-sans-arabic/files/ibm-plex-sans-arabic-arabic-500-normal.woff2", weight: "500" },
    { path: "../node_modules/@fontsource/ibm-plex-sans-arabic/files/ibm-plex-sans-arabic-arabic-600-normal.woff2", weight: "600" },
  ],
  // Keep the Latin subset ahead of the system fallback for mixed-language text.
  variable: "--font-arabic", display: "swap", preload: true, adjustFontFallback: false,
});
const latin = localFont({
  src: [
    { path: "../node_modules/@fontsource/ibm-plex-sans-arabic/files/ibm-plex-sans-arabic-latin-400-normal.woff2", weight: "400" },
    { path: "../node_modules/@fontsource/ibm-plex-sans-arabic/files/ibm-plex-sans-arabic-latin-500-normal.woff2", weight: "500" },
    { path: "../node_modules/@fontsource/ibm-plex-sans-arabic/files/ibm-plex-sans-arabic-latin-600-normal.woff2", weight: "600" },
  ],
  variable: "--font-latin", display: "swap", preload: false,
});
const codes = localFont({
  src: "../node_modules/@fontsource/ibm-plex-sans/files/ibm-plex-sans-latin-500-normal.woff2",
  weight: "500", variable: "--font-codes", display: "swap", preload: false,
});

export const metadata: Metadata = {
  title: "إدارة المركز | Courses",
  description: "إدارة فروع المركز وأعضائه",
};

export default async function RootLayout({ children }: LayoutProps<"/">) {
  const theme = (await cookies()).get("courses_theme")?.value === "dark" ? "dark" : "light";
  return (
    <html lang="ar" dir="rtl" data-theme={theme} className={`${arabic.variable} ${latin.variable} ${codes.variable}`}>
      <body><ThemeProvider initialTheme={theme}>{children}</ThemeProvider></body>
    </html>
  );
}
