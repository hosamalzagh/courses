import type { ReactNode } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

export type FormSectionLink = { id: string; title: string };

export function FormSectionsLayout({ sections, children }: { sections: FormSectionLink[]; children: ReactNode }) {
  return <div className="form-sections-layout">
    <FormSectionNavigation sections={sections} />
    <div className="form-sections-content">{children}</div>
  </div>;
}

export function FormSectionNavigation({ title = "أقسام النموذج", sections }: { title?: string; sections: FormSectionLink[] }) {
  return <nav aria-label={title} className="form-section-nav">
    <p className="form-section-nav-title">{title}</p>
    <ol>{sections.map((section) => <li key={section.id}><a href={`#${section.id}`}>{section.title}</a></li>)}</ol>
  </nav>;
}

export function FormSection({ id, title, description, children }: {
  id: string; title: string; description?: string; children: ReactNode;
}) {
  return <section id={id} aria-labelledby={`${id}-title`} className="form-section">
    <Card>
      <CardHeader className="border-b border-border pb-4">
        <CardTitle><h2 id={`${id}-title`}>{title}</h2></CardTitle>
        {description ? <CardDescription>{description}</CardDescription> : null}
      </CardHeader>
      <CardContent className="pt-1">{children}</CardContent>
    </Card>
  </section>;
}
