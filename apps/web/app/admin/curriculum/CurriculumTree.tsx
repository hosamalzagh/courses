"use client";

import { useEffect, useEffectEvent, useId, useRef, useState, useTransition, type ReactNode } from "react";
import { useSearchParams } from "next/navigation";
import { ChevronDown, ChevronLeft, Search, X } from "lucide-react";
import { Button } from "@/components/Button";
import { InlineNotice } from "@/components/InlineNotice";
import { PrefetchLink } from "@/components/PrefetchLink";
import { useWorkspaceRouter } from "@/components/WorkspaceNavigation";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Empty, EmptyHeader, EmptyTitle, EmptyDescription } from "@/components/ui/empty";
import { Field, FieldLabel } from "@/components/ui/field";
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from "@/components/ui/input-group";
import { centerRequest, responseMessage } from "@/lib/client-api";
import { curriculumExplorerHref, curriculumNodeKey, curriculumNodeLabels, type CurriculumNode, type CurriculumTree as TreeData, type CurriculumTreeBatch } from "@/lib/curriculum-explorer";
import { cn } from "@/lib/utils";

type BatchState = { batch?: CurriculumTreeBatch; loading?: boolean; error?: string };
function batchKey(batch: CurriculumTreeBatch) { return batch.parent ? curriculumNodeKey(batch.parent) : "root"; }
function initialBatches(tree: TreeData): Record<string, BatchState> {
  return Object.fromEntries([tree.root, ...tree.batches].map(batch => [batchKey(batch), { batch }]));
}

function TreeSearch({ value, pending, identity, onSearch }: { value: string; pending: boolean; identity: string; onSearch: (q: string) => void }) {
  const id = useId();
  const input = useRef<HTMLInputElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const composing = useRef(false);
  const [searchState, setSearchState] = useState({ draft: value, loaded: value, identity, revision: 0, submitted: {} as Record<string, number> });
  const draft = searchState.draft;
  if (searchState.loaded !== value || searchState.identity !== identity) {
    const sameSelection = searchState.identity === identity;
    const acknowledged = sameSelection ? searchState.submitted[value] : undefined;
    setSearchState({ ...searchState, loaded: value, identity,
      draft: acknowledged !== undefined && acknowledged < searchState.revision ? searchState.draft : value,
      submitted: sameSelection ? searchState.submitted : {} });
  }
  function setDraft(draft: string) { setSearchState(current => ({ ...current, draft, revision: current.revision + 1 })); }
  useEffect(() => {
    const cancel = () => { if (timer.current) clearTimeout(timer.current); };
    document.addEventListener("click", cancelLink, true);
    window.addEventListener("popstate", historyChanged);
    function historyChanged() {
      cancel();
      const q = new URL(window.location.href).searchParams.get("q") ?? "";
      setSearchState(current => ({ ...current, draft: q, submitted: {}, revision: current.revision + 1 }));
    }
    function cancelLink(event: MouseEvent) {
      if (event.target instanceof Element && event.target.closest("a[href]")) {
        cancel(); setSearchState(current => ({ ...current, submitted: {} }));
      }
    }
    return () => { cancel(); document.removeEventListener("click", cancelLink, true); window.removeEventListener("popstate", historyChanged); };
  }, [identity]);
  function search(q: string, immediate = false) {
    if (timer.current) clearTimeout(timer.current);
    if (composing.current) return;
    const submit = () => {
      const normalized = q.trim();
      setSearchState(current => ({ ...current, submitted: Object.fromEntries([...Object.entries(current.submitted).filter(([key]) => key !== normalized), [normalized, current.revision]].slice(-20)) }));
      onSearch(normalized);
    };
    if (immediate) submit();
    else timer.current = setTimeout(submit, 300);
  }
  return <form noValidate onSubmit={event => { event.preventDefault(); search(draft, true); }}>
    <Field>
      <FieldLabel htmlFor={id}>بحث في المنهج</FieldLabel>
      <InputGroup>
        <InputGroupInput id={id} ref={input} type="search" value={draft} maxLength={80}
          placeholder="كورس، مرحلة، مستوى أو مجموعة…" aria-busy={pending || undefined}
          onCompositionStart={() => { composing.current = true; if (timer.current) clearTimeout(timer.current); }}
          onCompositionEnd={event => { composing.current = false; search(event.currentTarget.value); }}
          onChange={event => { setDraft(event.target.value); search(event.target.value); }} />
        <InputGroupAddon align="inline-end">
          {draft ? <InputGroupButton aria-label="مسح بحث المنهج" onClick={() => { setDraft(""); search("", true); input.current?.focus(); }}><X /></InputGroupButton> : null}
          <InputGroupButton type="submit" aria-label="بحث في المنهج"><Search /></InputGroupButton>
        </InputGroupAddon>
      </InputGroup>
    </Field>
  </form>;
}

export function CurriculumTree({ tree, workspaceId, userId, onSelect, actions }: {
  tree: TreeData; workspaceId: string; userId: number; onSelect: (node: CurriculumNode) => void;
  actions?: (node: CurriculumNode) => ReactNode;
}) {
  const router = useWorkspaceRouter();
  const params = useSearchParams();
  const [pending, startTransition] = useTransition();
  const [batches, setBatches] = useState(() => initialBatches(tree));
  const [open, setOpen] = useState(() => new Set(tree.batches.flatMap(batch => batch.parent ? [curriculumNodeKey(batch.parent)] : [])));
  const openRef = useRef(open);
  openRef.current = open;
  const [loadedTree, setLoadedTree] = useState(tree);
  const requests = useRef(new Map<string, AbortController>());
  const treeIdentity = useRef(tree);
  treeIdentity.current = tree;
  useEffect(() => {
    const active = requests.current;
    return () => { for (const request of active.values()) request.abort(); active.clear(); };
  }, [tree]);
  const panel = useRef<HTMLElement>(null);
  const selected = tree.path.at(-1);
  const selectedKey = selected ? curriculumNodeKey(selected) : null;
  const storageKey = `courses-curriculum-tree:${userId}:${workspaceId}`;
  if (loadedTree !== tree) {
    setLoadedTree(tree);
    // Every open parent is now in the bounded URL, so SSR is authoritative after mutations.
    setBatches(initialBatches(tree));
    setOpen(new Set(tree.batches.flatMap(batch => batch.parent ? [curriculumNodeKey(batch.parent)] : [])));
  }
  useEffect(() => {
    const active = requests.current;
    try {
      const saved = JSON.parse(sessionStorage.getItem(storageKey) ?? "null") as { scroll?: unknown } | null;
      if (saved && typeof saved.scroll === "number" && panel.current) panel.current.scrollTop = saved.scroll;
    } catch { /* Storage is optional; the authorized path is already rendered by SSR. */ }
    return () => { for (const request of active.values()) request.abort(); active.clear(); };
  }, [storageKey]);
  function rememberExpandedEntries(changes: [string, number | null][]) {
    const url = new URL(window.location.href);
    const entries = new Map<string, number>((url.searchParams.get("expanded") ?? "").split(",").filter(Boolean).map(entry => {
      const [kind, id, number] = entry.split(":"); return [`${kind}:${id}`, Number(number)] as const;
    }));
    for (const [key, page] of changes) {
      if (page === null) entries.delete(key); else { entries.delete(key); entries.set(key, page); }
    }
    const expanded = [...entries].slice(-20).map(([key, number]) => `${key}:${number}`).join(",");
    if (expanded) url.searchParams.set("expanded", expanded); else url.searchParams.delete("expanded");
    // Next's native History API updates search params without another SSR request.
    if (url.href !== window.location.href) window.history.replaceState(null, "", url.pathname + url.search);
  }
  function rememberExpanded(key: string, page: number | null) { rememberExpandedEntries([[key, page]]); }

  const rememberRestoredBranches = useEffectEvent(() => {
    const selectedParents = new Set(tree.path.slice(0, -1).map(curriculumNodeKey));
    const ordered = [...tree.batches].sort((left, right) => Number(Boolean(left.parent && selectedParents.has(curriculumNodeKey(left.parent)))) - Number(Boolean(right.parent && selectedParents.has(curriculumNodeKey(right.parent)))));
    rememberExpandedEntries(ordered.flatMap(batch => batch.parent ? [[curriculumNodeKey(batch.parent), batch.page] as [string, number]] : []));
  });
  useEffect(() => { rememberRestoredBranches(); }, [tree]);

  async function loadChildren(node: CurriculumNode, page: number, append = false) {
    const key = curriculumNodeKey(node);
    const ownerTree = tree;
    requests.current.get(key)?.abort();
    const request = new AbortController();
    requests.current.set(key, request);
    setBatches(current => ({ ...current, [key]: { ...current[key], loading: true, error: "" } }));
    try {
      const query = new URLSearchParams({ kind: node.kind, id: node.id, page: String(page) });
      const response = await centerRequest(`curriculum-explorer/children?${query}`, "GET", undefined, request.signal, { redirectOnUnavailable: false });
      if (!response.ok) throw new Error(await responseMessage(response));
      const next = ((await response.json()) as { batch: CurriculumTreeBatch }).batch;
      if (request.signal.aborted || requests.current.get(key) !== request || treeIdentity.current !== ownerTree) return;
      if (!next.parent || curriculumNodeKey(next.parent) !== key) throw new Error("تغير مسار الأبناء. أعد تحميلها.");
      if (openRef.current.has(key)) rememberExpanded(key, next.page);
      setBatches(current => {
        const previous = append ? current[key]?.batch?.items ?? [] : [];
        return { ...current, [key]: { batch: { ...next, items: [...previous, ...next.items.filter(item => !previous.some(row => curriculumNodeKey(row) === curriculumNodeKey(item)))] } } };
      });
    } catch (failure) {
      if (!request.signal.aborted && requests.current.get(key) === request && treeIdentity.current === ownerTree) setBatches(current => ({ ...current, [key]: { ...current[key], loading: false, error: failure instanceof Error ? failure.message : "تعذر تحميل الأبناء." } }));
    } finally { if (requests.current.get(key) === request) requests.current.delete(key); }
  }

  function disclose(node: CurriculumNode, expanded: boolean) {
    const key = curriculumNodeKey(node);
    setOpen(current => { const next = new Set(current); if (expanded) next.add(key); else next.delete(key); return next; });
    rememberExpanded(key, expanded ? batches[key]?.batch?.page ?? 1 : null);
    if (expanded && !batches[key]?.batch && !batches[key]?.loading) void loadChildren(node, 1);
  }
  function selectionHref(node: CurriculumNode) { const next = new URLSearchParams(params.toString()); next.delete("q"); next.delete("search_page"); return curriculumExplorerHref(node, next.toString()); }
  function selectedChildren(parent: CurriculumNode | null, items: CurriculumNode[]) {
    const pinned = [...tree.path, ...Object.values(batches).flatMap(state => state.batch?.parent ? [state.batch.parent] : [])]
      .filter(node => parent ? node.path.length > 1 && node.path.at(-2)?.id === parent.id : node.kind === "course");
    return [...items, ...pinned.filter((node, index) => !items.some(row => curriculumNodeKey(row) === curriculumNodeKey(node))
      && pinned.findIndex(row => curriculumNodeKey(row) === curriculumNodeKey(node)) === index)];
  }

  function renderNode(node: CurriculumNode) {
    const key = curriculumNodeKey(node);
    const state = batches[key];
    const expanded = node.kind !== "group" && open.has(key) && Boolean(state?.batch || state?.loading || state?.error);
    const active = key === selectedKey;
    return <li key={key} className="min-w-0" data-curriculum-node={key}>
      <Collapsible open={expanded} onOpenChange={value => disclose(node, value)}>
        <div className="flex min-w-0 items-center gap-1 py-0.5">
          {node.kind !== "group" ? <CollapsibleTrigger render={<Button variant="ghost" size="icon-sm" />}
            aria-label={`${expanded ? "طي" : "فتح"} أبناء ${node.name}`}>
            {expanded ? <ChevronDown /> : <ChevronLeft />}
          </CollapsibleTrigger> : <span className="size-7 shrink-0" aria-hidden="true" />}
          <PrefetchLink href={selectionHref(node)} scroll={false}
            className={cn(buttonVariants({ variant: active ? "secondary" : "ghost", size: "sm" }), "min-w-0 shrink justify-start")}
            aria-current={active ? "page" : undefined} data-preserve-dirty-navigation={active ? "true" : undefined} data-curriculum-select={key} onClick={() => onSelect(node)}>
            <bdi className="truncate" title={node.name}>{node.name}</bdi>
          </PrefetchLink>
          <Badge variant="outline" aria-label={`${node.child_count.toLocaleString("ar-EG")} ${node.kind === "course" ? "مرحلة" : node.kind === "stage" ? "مستوى" : node.kind === "level" ? "مجموعة" : "محاضرة"}`}>{node.child_count.toLocaleString("ar-EG")}</Badge>
          {actions?.(node)}
        </div>
        {node.kind !== "group" ? <CollapsibleContent>
          <div className="ms-3 border-s border-border ps-1">
            {state?.batch ? <>
              {state.batch.items.length || selectedChildren(node, []).length ? <ul aria-label={`أبناء ${node.name}`} className="m-0 list-none p-0">{selectedChildren(node, state.batch.items).map(renderNode)}</ul>
                : <p className="py-2 text-sm text-muted-foreground">لا يوجد أبناء في هذه الدفعة.</p>}
              {state.batch.page > 1 ? <Button size="sm" disabled={state.loading} onClick={() => void loadChildren(node, state.batch!.page - 1)}>الدفعة السابقة من أبناء {node.name}</Button> : null}
              {state.batch.has_more ? <Button size="sm" disabled={state.loading} onClick={() => void loadChildren(node, state.batch!.page + 1, true)}>المزيد من أبناء {node.name}</Button> : null}
            </> : null}
            {state?.loading ? <p role="status" className="py-2">جارٍ تحميل أبناء {node.name}…</p> : null}
            {state?.error ? <><InlineNotice tone="error">{state.error}</InlineNotice><Button size="sm" onClick={() => void loadChildren(node, state.batch?.page ?? 1)}>إعادة تحميل أبناء {node.name}</Button></> : null}
          </div>
        </CollapsibleContent> : null}
      </Collapsible>
    </li>;
  }
  function search(q: string) {
    const next = new URLSearchParams(params.toString());
    if (q.trim()) next.set("q", q.trim()); else next.delete("q");
    next.delete("search_page");
    startTransition(() => router.replace(`/admin/curriculum?${next}`, { scroll: false }));
  }
  function pageHref(key: string, page: number) { const next = new URLSearchParams(params.toString()); if (page > 1) next.set(key, String(page)); else next.delete(key); return `/admin/curriculum?${next}`; }
  const searchActive = tree.search.q !== "";
  const root = batches.root?.batch ?? tree.root;
  return <Card size="sm" className="min-w-0">
    <CardHeader><CardTitle>شجرة المنهج</CardTitle><TreeSearch identity={`${selectedKey}:${params.get("intent") ?? ""}`} value={tree.search.q} pending={pending} onSearch={search} /></CardHeader>
    <CardContent>
      <nav ref={panel} aria-label="شجرة المنهج" className="min-w-0 min-[901px]:max-h-[calc(100dvh-14rem)] min-[901px]:overflow-auto"
        onScroll={() => { try { sessionStorage.setItem(storageKey, JSON.stringify({ scroll: panel.current?.scrollTop ?? 0 })); } catch { /* Optional position retention. */ } }}>
        {pending ? <p role="status">جارٍ البحث في المنهج…</p> : null}
        {searchActive ? <>
          {tree.search.items.length ? <ul aria-label="نتائج بحث المنهج" className="m-0 flex list-none flex-col gap-2 p-0">
            {tree.search.items.map(node => <li key={curriculumNodeKey(node)} className="min-w-0">
              <PrefetchLink href={selectionHref(node)} scroll={false} data-preserve-dirty-navigation={curriculumNodeKey(node) === selectedKey ? "true" : undefined} onClick={() => onSelect(node)} className="flex min-w-0 flex-col gap-1">
                <span><bdi>{node.name}</bdi> · {curriculumNodeLabels[node.kind]}</span>
                <span className="break-words text-sm text-muted-foreground">{node.path.map(item => item.name).join(" ← ")}</span>
              </PrefetchLink>
            </li>)}
          </ul> : <Empty><EmptyHeader><EmptyTitle>لا توجد نتائج</EmptyTitle><EmptyDescription>غيّر الاسم أو امسح البحث لعرض الشجرة.</EmptyDescription></EmptyHeader></Empty>}
          <div className="flex flex-wrap items-center gap-2 py-2" aria-label="دفعات بحث المنهج">
            {tree.search.page > 1 ? <PrefetchLink href={pageHref("search_page", tree.search.page - 1)} scroll={false} data-preserve-dirty-navigation="true">الدفعة السابقة</PrefetchLink> : null}
            {tree.search.has_more ? <PrefetchLink href={pageHref("search_page", tree.search.page + 1)} scroll={false} data-preserve-dirty-navigation="true">الدفعة التالية</PrefetchLink> : null}
          </div>
        </> : <>
          {root.items.length || tree.path.length ? <ul aria-label="كورسات الفرع" className="m-0 list-none p-0">{selectedChildren(null, root.items).map(renderNode)}</ul>
            : <Empty><EmptyHeader><EmptyTitle>لا توجد كورسات</EmptyTitle><EmptyDescription>يمكن لصاحب الصلاحية إنشاء كورس من الهيدر.</EmptyDescription></EmptyHeader></Empty>}
          <div className="flex flex-wrap items-center gap-2 py-2" aria-label="دفعات كورسات الشجرة">
            {root.page > 1 ? <PrefetchLink href={pageHref("courses_page", root.page - 1)} scroll={false} data-preserve-dirty-navigation="true">الدفعة السابقة</PrefetchLink> : null}
            {root.has_more ? <PrefetchLink href={pageHref("courses_page", root.page + 1)} scroll={false} data-preserve-dirty-navigation="true">الدفعة التالية</PrefetchLink> : null}
          </div>
        </>}
      </nav>
    </CardContent>
  </Card>;
}
