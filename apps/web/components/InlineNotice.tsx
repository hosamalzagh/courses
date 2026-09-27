import type { ReactNode } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";

type Props = { children: ReactNode; tone?: "info" | "error" | "warning" };

export function InlineNotice({ children, tone = "info" }: Props) {
  return <Alert role={tone === "error" ? "alert" : "status"} variant={tone === "error" ? "destructive" : "default"}>
    <AlertDescription>{children}</AlertDescription>
  </Alert>;
}
