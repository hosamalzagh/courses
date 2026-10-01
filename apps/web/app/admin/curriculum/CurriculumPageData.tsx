import "server-only";
import { curriculumExplorerQuery, loadCurriculumExplorer } from '@/lib/server-context';
import { CenterAccessState } from '@/components/CenterAccessState';
import { CenterPage } from '@/components/CenterPage';
import { curriculumExplorerHref } from '@/lib/curriculum-explorer';
import { CurriculumExplorerWorkspace } from './CurriculumExplorerWorkspace';
import { CurriculumWorkspace } from './CurriculumWorkspace';

export async function CurriculumPageData({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const params = await searchParams;
  const context = await loadCurriculumExplorer(curriculumExplorerQuery(params));
  if (typeof context === 'string') return <CenterAccessState state={context} />;
  if (context.workspace?.mode !== "branch" && context.curriculum) {
    const curriculum = { ...context, ...context.curriculum };
    return <CurriculumWorkspace context={curriculum} section={curriculum.navigation?.stage ? "levels" : curriculum.navigation ? "stages" : params.tab === "stages" || params.tab === "levels" ? params.tab : "courses"} />;
  }
  const selected = context.tree.path.at(-1);
  const current = new URLSearchParams(Object.entries(params).flatMap(([key, value]) => typeof value === "string" ? [[key, value]] : []));
  const preserveSearchParams = ["expanded", "q", "search_page", "courses_page"];
  const trail = [{ label: "الكورسات", href: curriculumExplorerHref(null, current.toString()), preserveSearchParams }, ...context.tree.path.slice(0, -1).map(node => ({ label: node.name, href: curriculumExplorerHref(node, current.toString()), preserveSearchParams }))];
  return <CenterPage context={context} path="/admin/curriculum" title={selected ? selected.kind === "course" ? `مراحل ${selected.name}` : selected.kind === "stage" ? `مستويات ${selected.name}` : selected.kind === "level" ? `خطة ${selected.name}` : selected.name : "منهج الفرع"} trail={trail}>
    <CurriculumExplorerWorkspace context={context} />
  </CenterPage>;
}
