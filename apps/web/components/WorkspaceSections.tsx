"use client";

import { useEffect, useRef, type ReactNode } from "react";
import { useSearchParams } from "next/navigation";
import { PrefetchLink } from "./PrefetchLink";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./ui/tabs";

// Route-backed peer views share keyboard navigation and the existing link guard.
// Only the selected view mounts its controls and registers header actions.
export function WorkspaceSections({ value, label, path, sections }: {
  value: string;
  label: string;
  path: string;
  sections: { value: string; label: string; content: ReactNode }[];
}) {
  const params = useSearchParams();
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => {
    list.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [value]);
  function href(next: string) {
    const query = new URLSearchParams(params.toString());
    query.set("tab", next);
    return `${path}?${query}`;
  }
  return <Tabs value={value} className="workspace-sections">
    <div className="workspace-sections-scroll">
      <TabsList ref={list} variant="line" aria-label={label} activateOnFocus={false}>
        {sections.map((section) => <TabsTrigger key={section.value} value={section.value} nativeButton={false}
          render={<PrefetchLink href={href(section.value)} scroll={false} prefetchOnFocus={false} />}>
          {section.label}
        </TabsTrigger>)}
      </TabsList>
    </div>
    {sections.map((section) => <TabsContent key={section.value} value={section.value} className="workspace-section-content">
      {section.value === value ? section.content : null}
    </TabsContent>)}
  </Tabs>;
}
