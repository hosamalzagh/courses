import type { Metadata } from "next";
import { SettingsPageData } from "./SettingsPageData";

export const metadata: Metadata = { title: "الإعدادات | Courses" };

export default function SettingsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  return <SettingsPageData searchParams={searchParams} />;
}
