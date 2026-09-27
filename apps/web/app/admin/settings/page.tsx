import type { Metadata } from "next";
import { SettingsPageData } from "./SettingsPageData";

export const metadata: Metadata = { title: "إعدادات المركز | Courses" };

export default function SettingsPage() {
  return <SettingsPageData />;
}
