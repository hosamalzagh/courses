import type { Metadata } from "next";
import { cookies } from "next/headers";
import { ThemeProvider } from "@/components/ThemeProvider";
import "@fontsource/ibm-plex-sans-arabic/400.css";
import "@fontsource/ibm-plex-sans-arabic/500.css";
import "@fontsource/ibm-plex-sans-arabic/600.css";
import "@fontsource/ibm-plex-sans/500.css";
import "./globals.css";

export const metadata: Metadata = {
  title: "إدارة المركز | Courses",
  description: "إدارة فروع المركز وأعضائه",
};

export default async function RootLayout({ children }: LayoutProps<"/">) {
  const theme = (await cookies()).get("courses_theme")?.value === "dark" ? "dark" : "light";
  return (
    <html lang="ar" dir="rtl" data-theme={theme}>
      <body><ThemeProvider initialTheme={theme}>{children}</ThemeProvider></body>
    </html>
  );
}
