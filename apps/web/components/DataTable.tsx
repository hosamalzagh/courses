"use client";

import { Fragment, useEffect, useRef, useState, type ReactNode } from "react";
import { Button } from "./Button";
import { FormField } from "./FormField";
import { TablePopover } from "./TablePopover";
import { useTablePreferences } from "./TablePreferences";

export type TableColumn<T> = { key: string; label: string; render: (row: T) => ReactNode; actions?: boolean; filterText?: (row: T) => string };
type Props<T> = {
  id: string; title: string; description?: string; rows: T[]; columns: TableColumn<T>[];
  rowKey: (row: T) => string | number; searchText: (row: T) => string;
  emptyMessage: string; action?: ReactNode; filters?: { label: string; value: string; matches: (row: T) => boolean }[];
  expanded?: (row: T) => ReactNode; rowClassName?: string;
};
const pageSize = 10;


export function DataTable<T>({ id, title, description, rows, columns, rowKey, searchText, emptyMessage, action, filters = [], expanded, rowClassName }: Props<T>) {
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState("");
  const [page, setPage] = useState(1);
  const [columnFilters, setColumnFilters] = useState<Record<string, string>>({});
  const [draftFilters, setDraftFilters] = useState<Record<string, string>>({});
  const [draftFilter, setDraftFilter] = useState("");
  const [announcement, setAnnouncement] = useState("");
  const preferences = useTablePreferences(id, columns);
  const draggableColumn = useRef<string | null>(null);
  const tableRef = useRef<HTMLTableElement>(null);
  const filterable = columns.filter((column) => column.filterText);
  const filterKeys = filterable.map((column) => column.key).join("|");
  const shownColumns = preferences.ordered.map((key) => columns.find((column) => column.key === key)!).filter((column) => !preferences.hidden.includes(column.key));
  const [ready, setReady] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    function restore() {
      const params = new URLSearchParams(location.search);
      setSearch(params.get(`${id}-q`) ?? "");
      setFilter(params.get(`${id}-filter`) ?? "");
      setPage(Math.max(1, Number(params.get(`${id}-page`)) || 1));
      setColumnFilters(Object.fromEntries(filterKeys.split("|").filter(Boolean).map((key) => [key, params.get(`${id}-f-${key}`) ?? ""])));
      setReady(true);
    }
    restore();
    window.addEventListener("popstate", restore);
    return () => window.removeEventListener("popstate", restore);
  }, [id, filterKeys]);

  const activeFilter = filters.find((item) => item.value === filter);
  const query = search.trim().toLocaleLowerCase("ar-EG");
  const visible = rows.filter((row) => (!query || searchText(row).toLocaleLowerCase("ar-EG").includes(query)) && (!activeFilter || activeFilter.matches(row)) && filterable.every((column) => {
    const value = columnFilters[column.key]?.trim().toLocaleLowerCase("ar-EG");
    return !value || column.filterText!(row).toLocaleLowerCase("ar-EG").includes(value);
  }));
  const filterCount = (activeFilter ? 1 : 0) + filterable.filter((column) => columnFilters[column.key]?.trim()).length;
  const pages = Math.max(1, Math.ceil(visible.length / pageSize));
  const currentPage = Math.min(Math.floor(page), pages);
  if (ready && page !== currentPage) setPage(currentPage);
  const start = (currentPage - 1) * pageSize;
  const pageRows = visible.slice(start, start + pageSize);

  useEffect(() => {
    if (!ready) return;
    const url = new URL(location.href);
    url.searchParams.delete(`${id}-density`);
    for (const key of [...url.searchParams.keys()]) if (key.startsWith(`${id}-f-`)) url.searchParams.delete(key);
    for (const column of filterable) if (columnFilters[column.key]?.trim()) url.searchParams.set(`${id}-f-${column.key}`, columnFilters[column.key].trim());
    for (const [key, value] of Object.entries({ q: search, filter: activeFilter?.value ?? "", page: currentPage > 1 ? String(currentPage) : "" })) {
      if (value) url.searchParams.set(`${id}-${key}`, value); else url.searchParams.delete(`${id}-${key}`);
    }
    if (url.href !== location.href) window.history.replaceState(window.history.state, "", url);
  }, [id, search, activeFilter?.value, page, currentPage, columnFilters, filterable, ready]);

  function closeFilters() {
    document.getElementById(`${id}-filters`)?.hidePopover();
    document.getElementById(`${id}-filters-trigger`)?.focus();
  }

  return <section className="data-panel" aria-labelledby={`${id}-title`} data-density="compact">
    <div className="table-heading"><div><h2 id={`${id}-title`}>{title}<span className="record-count">{rows.length.toLocaleString("ar-EG")}</span></h2>{description ? <p className="muted">{description}</p> : null}</div>{action}</div>
    <div className="table-toolbar">
      <div className="table-search"><label className="sr-only" htmlFor={`${id}-search`}>بحث في {title}</label><span aria-hidden="true">⌕</span><input ref={input} id={`${id}-search`} type="search" value={search} placeholder={`بحث في ${title}…`} onChange={(event) => { setSearch(event.target.value); setPage(1); }} />{search ? <button type="button" aria-label={`مسح البحث في ${title}`} onClick={() => { setSearch(""); setPage(1); input.current?.focus(); }}>×</button> : null}</div>
      <div className="table-tools">
        <TablePopover id={`${id}-columns`} label="الأعمدة" scope={title} title={`الأعمدة المعروضة — ${title}`}>
          <>
            <p className="muted popover-hint">اسحب رأس العمود لتغيير مكانه، أو استخدم أزرار الترتيب هنا.</p>
            <div className="column-options">{preferences.ordered.map((key) => {
              const column = columns.find((item) => item.key === key)!;
              const index = preferences.movable.indexOf(key);
              const required = column.actions || key === columns.find((item) => !item.actions)?.key;
              return <div className="column-option" key={key}>
                <label className="check-row"><input type="checkbox" checked={!preferences.hidden.includes(key)} disabled={required} onChange={() => preferences.toggle(key)} />{column.label}{required ? <span className="muted">(دائمًا)</span> : null}</label>
                {!column.actions ? <div className="column-move"><button type="button" disabled={index === 0} aria-label={`نقل ${column.label} قبل العمود السابق`} onClick={() => preferences.move(key, preferences.movable[index - 1])}>↑</button><button type="button" disabled={index === preferences.movable.length - 1} aria-label={`نقل ${column.label} بعد العمود التالي`} onClick={() => preferences.move(key, preferences.movable[index + 1])}>↓</button></div> : <span className="muted">ثابت</span>}
              </div>;
            })}</div>
            <div className="popover-actions"><Button onClick={preferences.reset}>استعادة الأعمدة الافتراضية</Button></div>
          </>
        </TablePopover>
        <TablePopover id={`${id}-filters`} label="الفلاتر" scope={title} title={`تصفية ${title}`} count={filterCount} onOpen={() => { setDraftFilter(activeFilter?.value ?? ""); setDraftFilters({ ...columnFilters }); }}>
          <form className="filter-form" noValidate onSubmit={(event) => { event.preventDefault(); setFilter(draftFilter); setColumnFilters(draftFilters); setPage(1); closeFilters(); }}>
            {filters.length ? <fieldset className="filter-options"><legend>تصفية السجلات</legend><label className="check-row"><input type="radio" name={`${id}-scope`} checked={!draftFilter} onChange={() => setDraftFilter("")} />الكل</label>{filters.map((item) => <label className="check-row" key={item.value}><input type="radio" name={`${id}-scope`} checked={draftFilter === item.value} onChange={() => setDraftFilter(item.value)} />{item.label}</label>)}</fieldset> : null}
            {filterable.map((column) => <FormField key={column.key} id={`${id}-filter-${column.key}`} label={column.label} value={draftFilters[column.key] ?? ""} onChange={(value) => setDraftFilters((previous) => ({ ...previous, [column.key]: value }))} />)}
            <div className="popover-actions"><Button onClick={() => { setFilter(""); setColumnFilters({}); setPage(1); closeFilters(); }}>مسح الفلاتر</Button><Button type="submit" variant="primary">تطبيق</Button></div>
          </form>
        </TablePopover>
      </div>
    </div>
    <span id={`${id}-order-help`} className="sr-only">اسحب العمود لتغيير مكانه، أو اضغط Alt مع السهم الأيسر أو الأيمن. عمود الإجراءات ثابت.</span>
    <span className="sr-only" aria-live="polite">{announcement}</span>
    <div className="table-scroll" role="region" aria-label={`جدول ${title} — قابل للتمرير أفقيًا`} tabIndex={0}>
      <table ref={tableRef}><caption className="sr-only">{title}</caption><thead><tr>{shownColumns.map((column) => <th scope="col" key={column.key} data-column-key={column.key} className={column.actions ? "actions-column" : "reorderable-column"} tabIndex={column.actions ? undefined : 0} draggable={!column.actions} aria-describedby={column.actions ? undefined : `${id}-order-help`}
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
            }}><span>{column.label}</span>{!column.actions ? <span className="column-grip" aria-hidden="true">⠿</span> : null}</th>)}</tr></thead>
        <tbody>{pageRows.map((row) => <Fragment key={rowKey(row)}><tr className={rowClassName}>{shownColumns.map((column) => <td key={column.key} className={column.actions ? "actions-column" : undefined}>{column.render(row)}</td>)}</tr>{expanded?.(row) ? <tr className="table-detail-row"><td colSpan={shownColumns.length}>{expanded(row)}</td></tr> : null}</Fragment>)}</tbody>
      </table>
      {!visible.length ? <div className="table-empty"><h3>{rows.length ? "لا توجد نتائج مطابقة" : emptyMessage}</h3>{rows.length ? <><p className="muted">جرّب بحثًا آخر أو أعد ضبط التصفية.</p><Button onClick={() => { setSearch(""); setFilter(""); setColumnFilters({}); setPage(1); input.current?.focus(); }}>مسح البحث والتصفية</Button></> : null}</div> : null}
    </div>
    <div className="table-footer"><span aria-live="polite">{visible.length ? `${(start + 1).toLocaleString("ar-EG")}–${Math.min(start + pageSize, visible.length).toLocaleString("ar-EG")} من ${visible.length.toLocaleString("ar-EG")}` : "٠ سجل"}</span><div className="pagination" aria-label={`صفحات ${title}`}><Button disabled={currentPage === 1} onClick={() => setPage(currentPage - 1)} aria-label={`الصفحة السابقة في ${title}`}>السابق</Button><span>صفحة {currentPage.toLocaleString("ar-EG")} من {pages.toLocaleString("ar-EG")}</span><Button disabled={currentPage === pages} onClick={() => setPage(currentPage + 1)} aria-label={`الصفحة التالية في ${title}`}>التالي</Button></div></div>
  </section>;
}
