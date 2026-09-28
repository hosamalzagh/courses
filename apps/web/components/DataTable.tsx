"use client";

import { RadioGroup, RadioGroupItem } from "./ui/radio-group";
import { InputGroup, InputGroupInput, InputGroupAddon, InputGroupButton } from "./ui/input-group";
import { Table, TableHeader, TableBody, TableHead, TableRow, TableCell, TableCaption } from "./ui/table";
import { Empty, EmptyHeader, EmptyTitle, EmptyDescription, EmptyContent } from "./ui/empty";
import { Checkbox } from "@/components/ui/checkbox";
import { FieldLabel, FieldGroup, FieldSet, FieldLegend } from "@/components/ui/field";
import { Button } from "@/components/Button";


import { Fragment, useEffect, useRef, useState, type ReactNode } from "react";

import { FormField } from "./FormField";
import { TablePopover } from "./TablePopover";
import { useTablePreferences } from "./TablePreferences";

export type TableColumn<T> = { key: string; label: string; render: (row: T) => ReactNode; actions?: boolean; filterText?: (row: T) => string };
type Props<T> = {
  id: string; title: string; description?: string; rows: T[]; columns: TableColumn<T>[];
  rowKey: (row: T) => string | number; searchText: (row: T) => string;
  emptyMessage: string; action?: ReactNode; filters?: { label: string; value: string; matches: (row: T) => boolean }[];
  expanded?: (row: T) => ReactNode; rowClassName?: string;
  pageSize?: number; serverSearch?: { value: string; onSearch: (value: string) => void };
  serverPagination?: { page: number; hasMore: boolean; batchSize: number; onPageChange: (page: number) => void };
};


export function DataTable<T>({ id, title, description, rows, columns, rowKey, searchText, emptyMessage, action, filters = [], expanded, rowClassName, pageSize = 10, serverSearch, serverPagination }: Props<T>) {
  const serverSearchValue = serverSearch?.value;
  const hasServerSearch = Boolean(serverSearch);
  const [search, setSearch] = useState("");
  const [loadedServerSearch, setLoadedServerSearch] = useState(serverSearchValue);
  const [loadedServerPage, setLoadedServerPage] = useState(serverPagination?.page);
  const [filter, setFilter] = useState("");
  const [page, setPage] = useState(1);
  const [columnFilters, setColumnFilters] = useState<Record<string, string>>({});
  const [draftFilters, setDraftFilters] = useState<Record<string, string>>({});
  const [draftFilter, setDraftFilter] = useState("");
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [announcement, setAnnouncement] = useState("");
  const preferences = useTablePreferences(id, columns);
  const draggableColumn = useRef<string | null>(null);
  const tableRef = useRef<HTMLTableElement>(null);
  const filterable = columns.filter((column) => column.filterText);
  const filterKeys = filterable.map((column) => column.key).join("|");
  const shownColumns = preferences.ordered.map((key) => columns.find((column) => column.key === key)!).filter((column) => !preferences.hidden.includes(column.key));
  const [ready, setReady] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  if (loadedServerSearch !== serverSearchValue) {
    setLoadedServerSearch(serverSearchValue); setSearch(serverSearchValue ?? ""); setPage(1);
  }
  if (loadedServerPage !== serverPagination?.page) {
    setLoadedServerPage(serverPagination?.page); setPage(1);
  }

  useEffect(() => {
    function restore() {
      const params = new URLSearchParams(location.search);
      setSearch(hasServerSearch ? serverSearchValue ?? "" : params.get(`${id}-q`) ?? "");
      setFilter(params.get(`${id}-filter`) ?? "");
      setPage(Math.max(1, Number(params.get(`${id}-page`)) || 1));
      setColumnFilters(Object.fromEntries(filterKeys.split("|").filter(Boolean).map((key) => [key, params.get(`${id}-f-${key}`) ?? ""])));
      setReady(true);
    }
    restore();
    window.addEventListener("popstate", restore);
    return () => window.removeEventListener("popstate", restore);
  }, [id, filterKeys, serverSearchValue, hasServerSearch]);

  const activeFilter = filters.find((item) => item.value === filter);
  const query = search.trim().toLocaleLowerCase("ar-EG");
  const visible = rows.filter((row) => (hasServerSearch || !query || searchText(row).toLocaleLowerCase("ar-EG").includes(query)) && (!activeFilter || activeFilter.matches(row)) && filterable.every((column) => {
    const value = columnFilters[column.key]?.trim().toLocaleLowerCase("ar-EG");
    return !value || column.filterText!(row).toLocaleLowerCase("ar-EG").includes(value);
  }));
  const filterCount = (activeFilter ? 1 : 0) + filterable.filter((column) => columnFilters[column.key]?.trim()).length;
  const pages = Math.max(1, Math.ceil(visible.length / pageSize));
  const currentPage = Math.min(Math.floor(page), pages);
  if (ready && page !== currentPage) setPage(currentPage);
  const start = (currentPage - 1) * pageSize;
  const pageRows = visible.slice(start, start + pageSize);
  const batchOffset = serverPagination ? (serverPagination.page - 1) * serverPagination.batchSize : 0;
  const hasPreviousPage = currentPage > 1 || Boolean(serverPagination && serverPagination.page > 1);
  const hasNextPage = currentPage < pages || Boolean(serverPagination?.hasMore);
  const previousPage = () => currentPage > 1 ? setPage(currentPage - 1) : serverPagination?.onPageChange(serverPagination.page - 1);
  const nextPage = () => currentPage < pages ? setPage(currentPage + 1) : serverPagination?.onPageChange(serverPagination.page + 1);

  useEffect(() => {
    if (!ready) return;
    const url = new URL(location.href);
    url.searchParams.delete(`${id}-density`);
    for (const key of [...url.searchParams.keys()]) if (key.startsWith(`${id}-f-`)) url.searchParams.delete(key);
    for (const column of filterable) if (columnFilters[column.key]?.trim()) url.searchParams.set(`${id}-f-${column.key}`, columnFilters[column.key].trim());
    for (const [key, value] of Object.entries({ ...(hasServerSearch ? {} : { q: search }), filter: activeFilter?.value ?? "", page: currentPage > 1 ? String(currentPage) : "" })) {
      if (value) url.searchParams.set(`${id}-${key}`, value); else url.searchParams.delete(`${id}-${key}`);
    }
    if (url.href !== location.href) window.history.replaceState(window.history.state, "", url);
  }, [id, search, activeFilter?.value, page, currentPage, columnFilters, filterable, ready, hasServerSearch]);

  function closeFilters() { setFiltersOpen(false); }

  return <section className="data-panel" aria-labelledby={`${id}-title`} data-density="compact">
    <div className="table-heading"><div><h2 id={`${id}-title`}>{title}<span className="record-count">{rows.length.toLocaleString("ar-EG")}</span></h2>{description ? <p className="muted">{description}</p> : null}</div>{action}</div>
    <div className="table-toolbar">
      <form className="w-full max-w-sm" role="search" onSubmit={(event) => { event.preventDefault(); serverSearch?.onSearch(search.trim()); }}><InputGroup><label className="sr-only" htmlFor={`${id}-search`}>بحث في {title}</label><InputGroupInput ref={input} id={`${id}-search`} type="search" value={search} placeholder={`${serverSearch ? "بحث في جميع" : "بحث في"} ${title}…`} onChange={(event) => { setSearch(event.target.value); setPage(1); }} />{search ? <InputGroupAddon align="inline-end"><InputGroupButton type="button" aria-label={`مسح البحث في ${title}`} onClick={() => { setSearch(""); setPage(1); serverSearch?.onSearch(""); input.current?.focus(); }}>×</InputGroupButton></InputGroupAddon> : null}{serverSearch ? <InputGroupAddon align="inline-end"><InputGroupButton type="submit" aria-label={`بحث في جميع ${title}`}>بحث</InputGroupButton></InputGroupAddon> : null}</InputGroup></form>
      <div className="table-tools">
        <TablePopover id={`${id}-columns`} label="الأعمدة" scope={title} title={`الأعمدة المعروضة — ${title}`}>
          <>
            <p className="muted popover-hint">اسحب رأس العمود لتغيير مكانه، أو استخدم أزرار الترتيب هنا.</p>
            <div className="column-options">{preferences.ordered.map((key) => {
              const column = columns.find((item) => item.key === key)!;
              const index = preferences.movable.indexOf(key);
              const required = column.actions || key === columns.find((item) => !item.actions)?.key;
              return <div className="column-option" key={key}>
                <FieldLabel className="flex items-center gap-2"><Checkbox  checked={!preferences.hidden.includes(key)} disabled={required} onCheckedChange={() => preferences.toggle(key)} />{column.label}{required ? <span className="muted">(دائمًا)</span> : null}</FieldLabel>
                {!column.actions ? <div className="column-move"><Button type="button" disabled={index === 0} aria-label={`نقل ${column.label} قبل العمود السابق`} onClick={() => preferences.move(key, preferences.movable[index - 1])}>↑</Button><Button type="button" disabled={index === preferences.movable.length - 1} aria-label={`نقل ${column.label} بعد العمود التالي`} onClick={() => preferences.move(key, preferences.movable[index + 1])}>↓</Button></div> : <span className="muted">ثابت</span>}
              </div>;
            })}</div>
            <div className="popover-actions"><Button onClick={preferences.reset}>استعادة الأعمدة الافتراضية</Button></div>
          </>
        </TablePopover>
        <TablePopover id={`${id}-filters`} label="الفلاتر" scope={title} title={`تصفية ${title}`} count={filterCount} open={filtersOpen} onOpenChange={setFiltersOpen} onOpen={() => { setDraftFilter(activeFilter?.value ?? ""); setDraftFilters({ ...columnFilters }); }}>
          <form className="filter-form" noValidate onSubmit={(event) => { event.preventDefault(); setFilter(draftFilter); setColumnFilters(draftFilters); setPage(1); closeFilters(); }}>
<FieldGroup>
            {filters.length ? <FieldSet className="filter-options"><FieldLegend>تصفية السجلات</FieldLegend><RadioGroup value={draftFilter} onValueChange={(value) => setDraftFilter(String(value))}><FieldLabel className="flex items-center gap-2"><RadioGroupItem value="" />الكل</FieldLabel>{filters.map((item) => <FieldLabel className="flex items-center gap-2" key={item.value}><RadioGroupItem value={item.value} />{item.label}</FieldLabel>)}</RadioGroup></FieldSet> : null}
            {filterable.map((column) => <FormField key={column.key} id={`${id}-filter-${column.key}`} label={column.label} value={draftFilters[column.key] ?? ""} onChange={(value) => setDraftFilters((previous) => ({ ...previous, [column.key]: value }))} />)}
            <div className="popover-actions"><Button onClick={() => { setFilter(""); setColumnFilters({}); setPage(1); closeFilters(); }}>مسح الفلاتر</Button><Button type="submit" variant="primary">تطبيق</Button></div>
          </FieldGroup>
</form>
        </TablePopover>
      </div>
    </div>
    <span id={`${id}-order-help`} className="sr-only">اسحب العمود لتغيير مكانه، أو اضغط Alt مع السهم الأيسر أو الأيمن. عمود الإجراءات ثابت.</span>
    <span className="sr-only" aria-live="polite">{announcement}</span>
    <Table ref={tableRef} containerProps={{ className: "table-scroll", role: "region", "aria-label": `جدول ${title} — قابل للتمرير أفقيًا`, tabIndex: 0 }}><TableCaption className="sr-only">{title}</TableCaption><TableHeader><TableRow>{shownColumns.map((column) => <TableHead scope="col" key={column.key} data-column-key={column.key} className={column.actions ? "actions-column" : "reorderable-column"} tabIndex={column.actions ? undefined : 0} draggable={!column.actions} aria-describedby={column.actions ? undefined : `${id}-order-help`}
            onDragStart={(event) => { if (column.actions) return; draggableColumn.current = column.key; event.dataTransfer.effectAllowed = "move"; event.dataTransfer.setData("text/plain", column.key); }}
            onDragOver={(event) => { if (!column.actions) event.preventDefault(); }}
            onDrop={(event) => { event.preventDefault(); if (!column.actions && draggableColumn.current) preferences.move(draggableColumn.current, column.key); draggableColumn.current = null; }}
            onDragEnd={() => { draggableColumn.current = null; }}
            onKeyDown={(event) => {
              if (column.actions || !event.altKey || !["ArrowLeft", "ArrowRight"].includes(event.key)) return;
              event.preventDefault();
              const keys = shownColumns.filter((item) => !item.actions).map((item) => item.key);
              const target = keys[keys.indexOf(column.key) + (event.key === "ArrowLeft" ? 1 : -1)];
              if (!target) return;
              preferences.move(column.key, target); setAnnouncement(`تغيّر ترتيب عمود ${column.label}`);
              requestAnimationFrame(() => tableRef.current?.querySelector<HTMLElement>(`th[data-column-key="${CSS.escape(column.key)}"]`)?.focus());
            }}><span>{column.label}</span>{!column.actions ? <span className="column-grip" aria-hidden="true">⠿</span> : null}</TableHead>)}</TableRow></TableHeader>
        <TableBody>{pageRows.map((row) => <Fragment key={rowKey(row)}><TableRow className={rowClassName}>{shownColumns.map((column) => <TableCell key={column.key} className={column.actions ? "actions-column" : undefined}>{column.render(row)}</TableCell>)}</TableRow>{expanded?.(row) ? <TableRow className="table-detail-row"><TableCell colSpan={shownColumns.length}>{expanded(row)}</TableCell></TableRow> : null}</Fragment>)}</TableBody>
      </Table>
      {!visible.length ? <Empty><EmptyHeader><EmptyTitle><h3>{rows.length ? "لا توجد نتائج مطابقة" : emptyMessage}</h3></EmptyTitle>{rows.length ? <EmptyDescription>جرّب بحثًا آخر أو أعد ضبط التصفية.</EmptyDescription> : null}</EmptyHeader>{rows.length ? <EmptyContent><Button onClick={() => { setSearch(""); setFilter(""); setColumnFilters({}); setPage(1); input.current?.focus(); }}>مسح البحث والتصفية</Button></EmptyContent> : null}</Empty> : null}
    <div className="table-footer"><span aria-live="polite">{visible.length ? `${(batchOffset + start + 1).toLocaleString("ar-EG")}–${(batchOffset + Math.min(start + pageSize, visible.length)).toLocaleString("ar-EG")}${serverPagination ? " من الدفعة المحمّلة" : ` من ${visible.length.toLocaleString("ar-EG")}`}` : "٠ سجل"}</span><div className="pagination" aria-label={`صفحات ${title}`}><Button disabled={!hasPreviousPage} onClick={previousPage} aria-label={`الصفحة السابقة في ${title}`}>السابق</Button><span>{serverPagination ? `دفعة ${serverPagination.page.toLocaleString("ar-EG")} · ` : ""}صفحة {currentPage.toLocaleString("ar-EG")} من {pages.toLocaleString("ar-EG")}</span><Button disabled={!hasNextPage} onClick={nextPage} aria-label={`الصفحة التالية في ${title}`}>التالي</Button></div></div>
  </section>;
}
