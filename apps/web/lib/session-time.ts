// PostgreSQL emits hour-only offsets (for example +03); Date requires +03:00.
export function parseSessionTime(value: string): Date {
  return new Date(value.replace(" ", "T").replace(/([+-]\d{2})$/, "$1:00"));
}

const cairo = new Intl.DateTimeFormat("ar-EG", {
  timeZone: "Africa/Cairo", dateStyle: "medium", timeStyle: "short",
});

export function formatSessionTime(value: string): string {
  return cairo.format(parseSessionTime(value));
}
