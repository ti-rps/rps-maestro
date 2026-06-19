"use client";

import { Suspense, useEffect, useState, type ReactNode } from "react";
import { useSearchParams } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { format } from "date-fns";
import { AlertTriangle, X, Copy, Check, ChevronRight, ChevronDown, ChevronUp } from "lucide-react";
import {
  notasApi,
  xmlMetricsApi,
  empresasApi,
  XML_STATUS_LABEL,
  XML_STATUS_STYLE,
  XML_DOC_TYPE_LABEL,
  type NotaStatus,
  type DocType,
  type DateField,
  type EmpresaAgg,
  type Overview,
  type TimeseriesRange,
} from "@/lib/xml-api";
import { Modal } from "@/components/ui/modal";
import { Skeleton, SkeletonRow } from "@/components/skeleton";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Table, THead, Th, TBody, Tr, Td } from "@/components/ui/table";
import { EmptyRow, EmptyState } from "@/components/ui/empty-state";
import { ErrorRow, ErrorState } from "@/components/ui/error-state";

const PAGE_SIZE = 50;

// "Travada"/"Sumida" ficam de fora: o backend nunca produz esses status (sempre
// 0), então seriam ruído. Os cards de Travadas/Sumidas no topo só aparecem se
// algum dia vier > 0.
const STATUS_FILTERS: { value: NotaStatus | "all"; label: string }[] = [
  { value: "all", label: "Todos" },
  { value: "arrived", label: "A Sincronizar" },
  { value: "synced", label: "Sincronizada" },
  { value: "pending_import", label: "Aguardando Importação" },
  { value: "imported", label: "Importada" },
  { value: "import_ignored", label: "Ignorada" },
];

const DOC_TYPES: (DocType | "all")[] = ["all", "NFE", "NFCE", "CTE"];

// Contagem por status pro chip de filtro, reaproveitando o /metrics/overview
// que já é buscado (zero backend novo). "all" = soma dos status filtráveis.
function statusChipCount(ov: Overview | undefined, value: NotaStatus | "all"): number | null {
  if (!ov) return null;
  if (value === "all") {
    return ov.arrived + ov.synced + ov.pending_import + ov.imported + ov.import_ignored;
  }
  return statusCount(ov, value);
}

// Formatação de números pt-BR: compacto pro display ("1,02 mi", "394,1 mil") e
// completo com separador de milhar pro tooltip ("1.018.038").
const compactFmt = new Intl.NumberFormat("pt-BR", {
  notation: "compact",
  maximumFractionDigits: 2,
});
const fullFmt = new Intl.NumberFormat("pt-BR");
function fmtCompact(n: number): string {
  return compactFmt.format(n);
}
function fmtFull(n: number): string {
  return fullFmt.format(n);
}

// Atrasa a propagação de um valor (ex.: texto de busca) por `ms` — evita refazer
// a chamada da API a cada tecla.
function useDebounced<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(id);
  }, [value, ms]);
  return debounced;
}

function fmtAgo(secs: number): string {
  if (secs < 60) return `${secs}s`;
  if (secs < 3600) return `${Math.floor(secs / 60)}min`;
  return `${Math.floor(secs / 3600)}h`;
}

// Indicador de frescor dos dados (data observability). Lê dataUpdatedAt do
// react-query — nenhum dado novo de backend. Re-renderiza a cada 5s pra manter
// o "há Xs" vivo.
function FreshnessIndicator({
  updatedAt,
  isFetching,
  isError,
}: {
  updatedAt: number;
  isFetching: boolean;
  isError: boolean;
}) {
  // `now` vem do state (init lazy + atualizado pelo intervalo), não de
  // Date.now() no corpo do render — impuro no render é proibido pela lint.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 5000);
    return () => clearInterval(id);
  }, []);

  if (isError) {
    return (
      <span className="inline-flex items-center gap-1.5 text-xs text-amber-600 dark:text-amber-400">
        <span className="h-1.5 w-1.5 rounded-full bg-amber-500" /> Desatualizado
      </span>
    );
  }
  if (isFetching) {
    return (
      <span className="inline-flex items-center gap-1.5 text-xs text-gray-500">
        <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-rps-olive-dark" /> Atualizando…
      </span>
    );
  }
  const secs = updatedAt && now ? Math.max(0, Math.round((now - updatedAt) / 1000)) : 0;
  return (
    <span
      className="inline-flex items-center gap-1.5 text-xs text-gray-500"
      title={updatedAt ? `Última atualização: ${format(new Date(updatedAt), "dd/MM/yyyy HH:mm:ss")}` : undefined}
    >
      <span className="h-1.5 w-1.5 rounded-full bg-rps-sage" /> Atualizado há {fmtAgo(secs)}
    </span>
  );
}

// Botão de copiar (ação passiva — não altera dado). Mostra um check por ~1.2s.
function CopyButton({ text, label }: { text: string; label: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        navigator.clipboard?.writeText(text).then(() => {
          setDone(true);
          setTimeout(() => setDone(false), 1200);
        });
      }}
      title={`Copiar ${label}`}
      aria-label={`Copiar ${label}`}
      className="shrink-0 rounded p-0.5 text-gray-400 opacity-0 transition hover:text-rps-olive-dark focus:opacity-100 group-hover:opacity-100"
    >
      {done ? (
        <Check className="h-3.5 w-3.5 text-rps-olive-dark" aria-hidden />
      ) : (
        <Copy className="h-3.5 w-3.5" aria-hidden />
      )}
    </button>
  );
}

function StatCard({
  label,
  value,
  hint,
  tone = "neutral",
  loading = false,
  title,
}: {
  label: string;
  value: string | number;
  hint?: string;
  tone?: "neutral" | "success" | "warning" | "danger";
  loading?: boolean;
  title?: string;
}) {
  const accent =
    tone === "success"
      ? "text-rps-olive-dark"
      : tone === "warning"
        ? "text-yellow-700"
        : tone === "danger"
          ? "text-red-700"
          : "text-gray-900 dark:text-gray-100";
  // Número grande → compacto; hover no próprio número mostra o valor cheio.
  const display = typeof value === "number" ? fmtCompact(value) : value;
  const valueTitle = typeof value === "number" ? fmtFull(value) : undefined;
  return (
    <div
      title={title}
      className={`rounded-lg border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 p-4 shadow-sm${title ? " cursor-help" : ""}`}
    >
      <p className="text-xs font-medium uppercase tracking-wider text-gray-500">{label}</p>
      {loading ? (
        <Skeleton className="mt-2 h-7 w-16" />
      ) : (
        <p className={`mt-1 text-2xl font-bold ${accent}`}>
          <span title={valueTitle} className={valueTitle ? "cursor-help" : undefined}>
            {display}
          </span>
        </p>
      )}
      {hint && <p className="mt-0.5 text-xs text-gray-500">{hint}</p>}
    </div>
  );
}

function fmtDur(s?: number): string {
  if (s == null) return "—";
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)} min`;
  // A partir de ~2 dias, mostrar em dias (ex.: 504h → "21d", 484h → "20d 4h") —
  // mais legível que "horas grandes" em latências de backlog.
  if (s >= 48 * 3600) {
    const wholeH = Math.round(s / 3600);
    const d = Math.floor(wholeH / 24);
    const h = wholeH % 24;
    return h ? `${d}d ${h}h` : `${d}d`;
  }
  const h = Math.floor(s / 3600);
  const m = Math.round((s % 3600) / 60);
  return m ? `${h}h ${m}min` : `${h}h`;
}

function fmtTs(s?: string): string {
  return s ? format(new Date(s), "dd/MM/yyyy HH:mm:ss") : "—";
}

function fmtBRL(v: number): string {
  return v.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

function fmtParty(nome?: string, doc?: string): string {
  if (nome && doc) return `${nome} (${doc})`;
  return nome || doc || "—";
}

export default function XmlPage() {
  // useSearchParams precisa de fronteira de Suspense no app router (senão o
  // prerender estático quebra). O conteúdo real fica no XmlPageContent.
  return (
    <Suspense fallback={<div className="text-sm text-gray-500">Carregando…</div>}>
      <XmlPageContent />
    </Suspense>
  );
}

function XmlPageContent() {
  const sp = useSearchParams();
  // Estado inicial vem da URL (deep-link/drill-down); depois espelhamos de
  // volta pra URL via replaceState a cada mudança de filtro.
  const [statusFilter, setStatusFilter] = useState<NotaStatus | "all">(
    () => (sp.get("status") as NotaStatus) || "all"
  );
  const [docFilter, setDocFilter] = useState<DocType | "all">(
    () => (sp.get("doc_type") as DocType) || "all"
  );
  const [view, setView] = useState<"notas" | "empresas" | "painel">(() => {
    const v = sp.get("view");
    return v === "empresas" || v === "painel" ? v : "notas";
  });
  const [q, setQ] = useState(() => sp.get("q") ?? "");
  const [empresa, setEmpresa] = useState(() => sp.get("empresa") ?? "");
  const [cnpj, setCnpj] = useState(() => sp.get("cnpj") ?? "");
  const [codigoEmpresa, setCodigoEmpresa] = useState<number | null>(() => {
    const v = sp.get("codigo_empresa");
    return v ? Number(v) : null;
  });
  const [codigoFilial, setCodigoFilial] = useState<number | null>(() => {
    const v = sp.get("codigo_filial");
    return v ? Number(v) : null;
  });
  const [semEmpresa, setSemEmpresa] = useState(() => sp.get("sem_empresa") === "true");
  const [dateField, setDateField] = useState<DateField>(
    () => (sp.get("date_field") as DateField) || "imported"
  );
  const [from, setFrom] = useState(() => sp.get("from") ?? "");
  const [to, setTo] = useState(() => sp.get("to") ?? "");
  const [offset, setOffset] = useState(() => Number(sp.get("offset")) || 0);
  const [selected, setSelected] = useState<string | null>(null);

  // Espelha os filtros na URL (sem navegar/refetch): URL compartilhável e
  // base pro drill-down por empresa do Bloco C1.
  useEffect(() => {
    const p = new URLSearchParams();
    if (view === "empresas" || view === "painel") p.set("view", view);
    if (statusFilter !== "all") p.set("status", statusFilter);
    if (docFilter !== "all") p.set("doc_type", docFilter);
    if (q) p.set("q", q);
    if (empresa) p.set("empresa", empresa);
    if (cnpj) p.set("cnpj", cnpj);
    if (semEmpresa) p.set("sem_empresa", "true");
    if (codigoEmpresa != null) p.set("codigo_empresa", String(codigoEmpresa));
    if (codigoFilial != null) p.set("codigo_filial", String(codigoFilial));
    if (from || to) {
      p.set("date_field", dateField);
      if (from) p.set("from", from);
      if (to) p.set("to", to);
    }
    if (offset) p.set("offset", String(offset));
    const qs = p.toString();
    window.history.replaceState(null, "", qs ? `/xml?${qs}` : "/xml");
  }, [view, statusFilter, docFilter, q, empresa, cnpj, semEmpresa, codigoEmpresa, codigoFilial, dateField, from, to, offset]);

  const overview = useQuery({
    queryKey: ["xml", "overview"],
    queryFn: () => xmlMetricsApi.overview().then((r) => r.data),
    refetchInterval: 10_000,
  });

  const list = useQuery({
    queryKey: ["xml", "notas", { statusFilter, docFilter, q, empresa, cnpj, semEmpresa, codigoEmpresa, codigoFilial, dateField, from, to, offset }],
    queryFn: () =>
      notasApi
        .list({
          status: statusFilter === "all" ? undefined : statusFilter,
          doc_type: docFilter === "all" ? undefined : docFilter,
          q: q || undefined,
          empresa: empresa || undefined,
          cnpj: cnpj || undefined,
          sem_empresa: semEmpresa || undefined,
          codigo_empresa: codigoEmpresa ?? undefined,
          codigo_filial: codigoFilial ?? undefined,
          date_field: from || to ? dateField : undefined,
          from: from || undefined,
          to: to || undefined,
          limit: PAGE_SIZE,
          offset,
        })
        .then((r) => r.data),
    refetchInterval: 15_000,
    placeholderData: (prev) => prev,
    enabled: view === "notas",
  });

  const ov = overview.data;
  const total = list.data?.total ?? 0;
  const items = list.data?.items ?? [];
  const page = Math.floor(offset / PAGE_SIZE) + 1;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  // "Pendente" = mesma definição do tracker (arrived+synced+pending_import+stuck;
  // stuck conta, lost não, terminais fora). Mantém cards e filtro alinhados.
  const pendentes = ov ? ov.arrived + ov.synced + ov.pending_import + ov.stuck : 0;
  const showStuck = overview.isLoading || (ov?.stuck ?? 0) > 0;
  const showLost = overview.isLoading || (ov?.lost ?? 0) > 0;

  function reset<T>(setter: (v: T) => void) {
    return (v: T) => {
      setter(v);
      setOffset(0);
    };
  }

  // Limpa o filtro de empresa (código, filial e o bucket "sem empresa").
  function clearEmpresaFilter() {
    setCodigoEmpresa(null);
    setCodigoFilial(null);
    setSemEmpresa(false);
    setOffset(0);
  }

  // Drill-down da visão por empresa → abre a aba Notas filtrada por aquela
  // (empresa, filial), ou pelo bucket "sem empresa".
  function drillToEmpresa(row: EmpresaAgg) {
    setStatusFilter("all");
    setOffset(0);
    if (row.codigo_empresa == null) {
      setSemEmpresa(true);
      setCodigoEmpresa(null);
      setCodigoFilial(null);
    } else {
      setSemEmpresa(false);
      setCodigoEmpresa(row.codigo_empresa);
      setCodigoFilial(row.codigo_filial ?? null);
    }
    setView("notas");
  }

  const empresaFilterLabel = semEmpresa
    ? "Sem empresa"
    : codigoEmpresa != null
      ? `#${codigoEmpresa}${codigoFilial != null ? `-${codigoFilial}` : ""}`
      : null;

  return (
    <div className="space-y-5">
      {/* Frescor dos dados (data observability) — responde "os dados estão
          atualizados?" sem depender de backend novo. */}
      <div className="flex justify-end">
        <FreshnessIndicator
          updatedAt={overview.dataUpdatedAt}
          isFetching={overview.isFetching}
          isError={overview.isError}
        />
      </div>

      {/* Banner: tracker indisponível/instável */}
      {(overview.isError || list.isError) && (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800 dark:border-amber-900/50 dark:bg-amber-950/30 dark:text-amber-300">
          <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden />
          <span>Rastreador XML indisponível ou instável — os dados podem estar desatualizados.</span>
          <button
            onClick={() => {
              overview.refetch();
              list.refetch();
            }}
            className="ml-auto rounded bg-amber-100 px-2 py-1 text-xs font-medium text-amber-900 hover:bg-amber-200 dark:bg-amber-900/40 dark:text-amber-200 dark:hover:bg-amber-900/60"
          >
            Tentar de novo
          </button>
        </div>
      )}

      {/* Cards do pipeline (Travadas/Sumidas só aparecem quando > 0) */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-6">
        <StatCard label="A Sincronizar" value={ov?.arrived ?? "—"} tone={ov?.arrived ? "warning" : "neutral"} loading={overview.isLoading} />
        <StatCard label="Sincronizadas" value={ov?.synced ?? "—"} loading={overview.isLoading} />
        <StatCard label="Aguardando Importação" value={ov?.pending_import ?? "—"} loading={overview.isLoading} />
        <StatCard label="Importadas hoje" value={ov?.imported_today ?? "—"} tone="success" loading={overview.isLoading} title="Contagem do dia. O filtro 'Importada' mostra todas." />
        <StatCard label="Ignoradas" value={ov?.import_ignored ?? "—"} loading={overview.isLoading} />
        {showStuck && (
          <StatCard label="Travadas" value={ov?.stuck ?? "—"} tone="danger" loading={overview.isLoading} />
        )}
        {showLost && (
          <StatCard label="Sumidas" value={ov?.lost ?? "—"} tone="danger" loading={overview.isLoading} />
        )}
      </div>
      {ov && (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-gray-500">
          <span>
            <b className="text-gray-700 dark:text-gray-300" title={fmtFull(pendentes)}>{fmtCompact(pendentes)}</b> pendentes
            <span className="text-gray-400"> (chegou + sincronizado + aguardando + travada)</span>
            {" · "}
            <span title={fmtFull(ov.in_transit)}>{fmtCompact(ov.in_transit)}</span> em trânsito
          </span>
          <span title="Percentis das transições dos últimos 30 dias; exclui backfill histórico.">
            Latência chegada→sync (30d): p50 <b className="text-gray-700 dark:text-gray-300">{fmtDur(ov.lat_arrival_sync_p50_s)}</b> · p95 {fmtDur(ov.lat_arrival_sync_p95_s)}
          </span>
          <span title="Percentis das transições dos últimos 30 dias; exclui backfill histórico.">
            Latência sync→import (30d): p50 <b className="text-gray-700 dark:text-gray-300">{fmtDur(ov.lat_sync_import_p50_s)}</b> · p95 {fmtDur(ov.lat_sync_import_p95_s)}
          </span>
        </div>
      )}

      {/* Navegação entre visões — segmented control, propositalmente distinto
          dos chips de filtro (que são pills olive). Aqui é uma trilha cinza com
          a aba ativa em "cartão" branco, pra não confundir "trocar de aba" com
          "filtrar". */}
      <div className="inline-flex rounded-lg border border-gray-200 dark:border-gray-700 bg-gray-100 dark:bg-gray-800 p-0.5">
        {(["notas", "empresas", "painel"] as const).map((v) => (
          <button
            key={v}
            onClick={() => {
              // sair da lista de Notas zera o filtro de empresa (ele só vale lá;
              // deixar grudado confunde ao voltar).
              if (v !== "notas") clearEmpresaFilter();
              setView(v);
            }}
            className={`rounded-md px-4 py-1.5 text-sm font-medium transition-colors ${
              view === v
                ? "bg-white dark:bg-gray-900 text-rps-olive-dark shadow-sm"
                : "text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-200"
            }`}
          >
            {v === "notas" ? "Notas" : v === "empresas" ? "Empresas" : "Painel"}
          </button>
        ))}
      </div>

      {view === "painel" ? (
        <PainelView
          ov={ov}
          loading={overview.isLoading}
          error={overview.isError}
          onRetry={() => overview.refetch()}
          onPickStatus={(s) => {
            clearEmpresaFilter();
            setView("notas");
            reset(setStatusFilter)(s);
          }}
          onDrillEmpresa={drillToEmpresa}
        />
      ) : view === "empresas" ? (
        <EmpresasView onDrill={drillToEmpresa} />
      ) : (
        <>
      {/* Filtros */}
      <div className="flex flex-wrap items-center gap-3">
        <span className="text-xs font-medium uppercase tracking-wider text-gray-500">Filtrar:</span>
        <div className="flex flex-wrap gap-1.5">
          {STATUS_FILTERS.map((s) => {
            const count = statusChipCount(ov, s.value);
            const active = statusFilter === s.value;
            return (
            <button
              key={s.value}
              onClick={() => {
                // trocar de status zera o filtro de empresa — senão ele fica
                // grudado e o resultado não bate com os cards globais.
                clearEmpresaFilter();
                reset(setStatusFilter)(s.value);
              }}
              className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium transition-colors ${
                active
                  ? "bg-rps-olive-dark text-white"
                  : "bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-700"
              }`}
            >
              {s.label}
              {count != null && (
                <span
                  title={fmtFull(count)}
                  className={`tabular-nums ${active ? "text-white/75" : "text-gray-400 dark:text-gray-500"}`}
                >
                  {fmtCompact(count)}
                </span>
              )}
            </button>
            );
          })}
        </div>
        <select
          value={docFilter}
          onChange={(e) => reset(setDocFilter)(e.target.value as DocType | "all")}
          className="rounded border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-900 px-2 py-1 text-sm focus:border-rps-olive-dark focus:outline-none"
        >
          {DOC_TYPES.map((d) => (
            <option key={d} value={d}>{d === "all" ? "Todos os tipos" : XML_DOC_TYPE_LABEL[d]}</option>
          ))}
        </select>
        <input
          value={q}
          onChange={(e) => reset(setQ)(e.target.value.trim())}
          placeholder="Buscar por chave de acesso…"
          className="min-w-[280px] flex-1 rounded border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-900 px-3 py-1.5 text-sm placeholder-gray-500 focus:border-rps-olive-dark focus:outline-none"
        />
        <span className="text-sm text-gray-500">
          {list.isFetching ? (
            "Atualizando…"
          ) : (
            <span title={fmtFull(total)}>
              {fmtCompact(total)} nota{total === 1 ? "" : "s"}
            </span>
          )}
        </span>
      </div>

      {/* Filtros: empresa, cnpj, data */}
      <div className="flex flex-wrap items-center gap-3">
        <input
          value={empresa}
          onChange={(e) => reset(setEmpresa)(e.target.value)}
          placeholder="Empresa (nome)…"
          className="w-48 rounded border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-900 px-3 py-1.5 text-sm placeholder-gray-500 focus:border-rps-olive-dark focus:outline-none"
        />
        <input
          value={cnpj}
          onChange={(e) => reset(setCnpj)(e.target.value.trim())}
          placeholder="CNPJ emit/dest…"
          className="w-44 rounded border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-900 px-3 py-1.5 text-sm placeholder-gray-500 focus:border-rps-olive-dark focus:outline-none"
        />
        <div className="flex items-center gap-1.5 text-sm text-gray-500">
          <select
            value={dateField}
            onChange={(e) => reset(setDateField)(e.target.value as DateField)}
            className="rounded border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-900 px-2 py-1 text-sm focus:border-rps-olive-dark focus:outline-none"
          >
            <option value="emissao">Data emissão</option>
            <option value="arrived">Data chegada</option>
            <option value="synced">Data sincronização</option>
            <option value="imported">Data importação</option>
          </select>
          <input type="date" value={from} onChange={(e) => reset(setFrom)(e.target.value)}
            className="rounded border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-900 px-2 py-1 text-sm focus:border-rps-olive-dark focus:outline-none" />
          <span>até</span>
          <input type="date" value={to} onChange={(e) => reset(setTo)(e.target.value)}
            className="rounded border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-900 px-2 py-1 text-sm focus:border-rps-olive-dark focus:outline-none" />
        </div>
      </div>

      {/* Filtro ativo de empresa (vindo de drill-down / URL) */}
      {empresaFilterLabel != null && (
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span className="text-gray-500">Filtrando por empresa:</span>
          <Badge shape="square" className="inline-flex items-center gap-1 bg-rps-sage-soft text-rps-olive-dark">
            {empresaFilterLabel}
            <button
              onClick={clearEmpresaFilter}
              aria-label="Remover filtro de empresa"
              className="rounded hover:text-rps-olive-darker"
            >
              <X className="h-3 w-3" aria-hidden />
            </button>
          </Badge>
        </div>
      )}

      {/* Tabela */}
      <Table stickyHeader>
        <THead sticky>
          <Th>Chave</Th>
          <Th>Número</Th>
          <Th>Tipo</Th>
          <Th>Empresa</Th>
          <Th>Emitente</Th>
          <Th>Status</Th>
          <Th>Importação</Th>
        </THead>
        <TBody>
          {items.map((n) => (
            <Tr
              key={n.chave_acesso}
              className="group cursor-pointer"
              onClick={() => setSelected(n.chave_acesso)}
            >
              <Td className="font-mono text-xs text-gray-600 dark:text-gray-400">
                <span className="inline-flex items-center gap-1.5">
                  <span title={n.chave_acesso}>…{n.chave_acesso.slice(-12)}</span>
                  <CopyButton text={n.chave_acesso} label="chave" />
                </span>
              </Td>
              <Td className="font-mono text-xs text-gray-600 dark:text-gray-400">{n.numero_nota || "—"}</Td>
              <Td className="text-gray-700 dark:text-gray-300">{XML_DOC_TYPE_LABEL[n.doc_type]}</Td>
              <Td className="max-w-[220px] truncate text-gray-700 dark:text-gray-300" title={n.nome_empresa}>
                {n.codigo_empresa ? (
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      setSemEmpresa(false);
                      setCodigoFilial(null);
                      reset(setCodigoEmpresa)(n.codigo_empresa!);
                    }}
                    className="truncate text-left hover:text-rps-olive-dark hover:underline"
                    title="Filtrar por esta empresa"
                  >
                    {n.nome_empresa || `#${n.codigo_empresa}-${n.codigo_filial ?? 1}`}
                  </button>
                ) : (
                  n.nome_empresa || "—"
                )}
              </Td>
              <Td className="max-w-[220px] truncate text-gray-600 dark:text-gray-400" title={n.nome_emitente}>
                {n.nome_emitente || n.cnpj_emitente || "—"}
              </Td>
              <Td>
                <Badge className={XML_STATUS_STYLE[n.status]}>{XML_STATUS_LABEL[n.status]}</Badge>
              </Td>
              <Td className="text-xs text-gray-500">{fmtTs(n.imported_at)}</Td>
            </Tr>
          ))}
          {list.isError && items.length === 0 && (
            <ErrorRow colSpan={7} onRetry={() => list.refetch()} />
          )}
          {!list.isLoading && !list.isError && items.length === 0 && (
            <EmptyRow colSpan={7}>Nenhuma nota encontrada com os filtros atuais.</EmptyRow>
          )}
          {list.isLoading && Array.from({ length: 6 }).map((_, i) => <SkeletonRow key={i} cols={7} />)}
        </TBody>
      </Table>

      {total > 0 && (
        <div className="flex items-center justify-between text-sm text-gray-600 dark:text-gray-400">
          <span>
            {fmtCompact(offset + 1)}–{fmtCompact(Math.min(offset + PAGE_SIZE, total))} de{" "}
            <span title={fmtFull(total)}>{fmtCompact(total)}</span>
          </span>
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
              disabled={offset === 0}
            >
              Anterior
            </Button>
            <span className="px-2 text-xs text-gray-500">{page} / {totalPages}</span>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setOffset(offset + PAGE_SIZE)}
              disabled={offset + PAGE_SIZE >= total}
            >
              Próximo
            </Button>
          </div>
        </div>
      )}
        </>
      )}

      {selected && <NotaDetailModal chave={selected} onClose={() => setSelected(null)} />}
    </div>
  );
}

// ── Painel (gráficos) ─────────────────────────────────────────────────────────

// Ordem das barras de status no painel (do início ao fim do pipeline + ramos
// terminais). Mesmos rótulos/cores da lista de notas pra leitura consistente.
const PAINEL_STATUSES: NotaStatus[] = [
  "arrived",
  "synced",
  "pending_import",
  "imported",
  "import_ignored",
  "stuck",
  "lost",
];

// Cor sólida da barra por status (o badge usa XML_STATUS_STYLE; aqui é só o
// preenchimento da barra de proporção).
const STATUS_BAR_FILL: Record<NotaStatus, string> = {
  arrived: "bg-yellow-400",
  synced: "bg-sky-400",
  pending_import: "bg-amber-400",
  imported: "bg-rps-olive-dark",
  import_ignored: "bg-gray-400 dark:bg-gray-600",
  stuck: "bg-orange-400",
  lost: "bg-red-500",
};

function statusCount(ov: Overview, s: NotaStatus): number {
  switch (s) {
    case "arrived":
      return ov.arrived;
    case "synced":
      return ov.synced;
    case "pending_import":
      return ov.pending_import;
    case "imported":
      return ov.imported;
    case "import_ignored":
      return ov.import_ignored;
    case "stuck":
      return ov.stuck;
    case "lost":
      return ov.lost;
  }
}

function PainelCard({
  title,
  action,
  className,
  children,
}: {
  title: string;
  action?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div
      className={`rounded-lg border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 p-5 shadow-sm ${className ?? ""}`}
    >
      <div className="mb-3 flex items-center justify-between gap-2">
        <h2 className="text-sm font-semibold text-gray-700 dark:text-gray-300">{title}</h2>
        {action}
      </div>
      {children}
    </div>
  );
}

function LatencyRow({ label, p50, p95 }: { label: string; p50?: number; p95?: number }) {
  return (
    <div>
      <p className="mb-1 text-xs font-medium text-gray-600 dark:text-gray-400">{label}</p>
      <div className="flex gap-4 text-sm text-gray-500">
        <span>
          p50 <b className="text-gray-800 dark:text-gray-200">{fmtDur(p50)}</b>
        </span>
        <span>
          p95 <b className="text-gray-800 dark:text-gray-200">{fmtDur(p95)}</b>
        </span>
      </div>
    </div>
  );
}

function MiniStat({
  label,
  value,
  tone,
}: {
  label: string;
  value: number | string;
  tone?: "success";
}) {
  const display = typeof value === "number" ? fmtCompact(value) : value;
  const valueTitle = typeof value === "number" ? fmtFull(value) : undefined;
  return (
    <div className="rounded border border-gray-200 dark:border-gray-800 p-2">
      <p className="text-xs text-gray-500">{label}</p>
      <p
        className={`text-lg font-bold ${tone === "success" ? "text-rps-olive-dark" : "text-gray-900 dark:text-gray-100"}`}
      >
        <span title={valueTitle} className={valueTitle ? "cursor-help" : undefined}>
          {display}
        </span>
      </p>
    </div>
  );
}

// ── Gráfico de linha (SVG, sem lib) ──────────────────────────────────────────

type ChartSeries = {
  label: string;
  // Classes Tailwind LITERAIS (o JIT não pega `stroke-${x}` interpolado).
  strokeCls: string;
  fillCls: string;
  swatchCls: string;
  values: (number | null)[];
};

// "2026-05-19" → "19/05" pro eixo X.
function ddmm(date: string): string {
  const p = date.split("-");
  return p.length === 3 ? `${p[2]}/${p[1]}` : date;
}

function chartHasData(series: ChartSeries[]): boolean {
  return series.some((s) => s.values.some((v) => v != null));
}

// Passos "humanos" de duração em segundos pra grade do eixo Y de latência —
// evita marcas tortas tipo 0h47min. Escolhe o menor passo cujo ×3 cobre o máx,
// e devolve [0, p, 2p, 3p].
const DUR_STEPS = [
  60, 300, 600, 1800, 3600, 2 * 3600, 6 * 3600, 12 * 3600,
  24 * 3600, 48 * 3600, 72 * 3600, 168 * 3600, 336 * 3600, 720 * 3600,
];
function niceDurationTicks(maxSeconds: number): number[] {
  const step = DUR_STEPS.find((s) => s * 3 >= maxSeconds) ?? DUR_STEPS[DUR_STEPS.length - 1];
  return [0, step, step * 2, step * 3];
}

// Gráfico de linhas multi-série. Quebra a linha em `null` (vira gap). Pontos
// têm <title> nativo pra tooltip. Cores via classe Tailwind (dark-aware).
function LineChart({
  series,
  xLabels,
  height = 170,
  formatY = (n) => String(Math.round(n)),
  formatTip,
  yTicks,
}: {
  series: ChartSeries[];
  xLabels: string[];
  height?: number;
  // formatY: rótulos do eixo (compacto). formatTip: tooltip do ponto (cheio);
  // cai no formatY se não informado.
  formatY?: (n: number) => string;
  formatTip?: (n: number) => string;
  // yTicks: marcas explícitas no eixo Y (ex.: durações redondas). Sem isso, usa
  // 0/meio/máx automático.
  yTicks?: number[];
}) {
  const tip = formatTip ?? formatY;
  const W = 640;
  const padL = 48;
  const padR = 12;
  const padT = 10;
  const padB = 22;
  const innerW = W - padL - padR;
  const innerH = height - padT - padB;
  const n = xLabels.length;

  const all = series.flatMap((s) => s.values).filter((v): v is number => v != null);
  const maxV = Math.max(1, ...all, ...(yTicks ?? []));

  const xAt = (i: number) => padL + (n <= 1 ? innerW / 2 : (i / (n - 1)) * innerW);
  const yAt = (v: number) => padT + innerH - (v / maxV) * innerH;

  const pathOf = (vals: (number | null)[]) => {
    let d = "";
    let pen = false; // caneta abaixada? (false após um gap)
    vals.forEach((v, i) => {
      if (v == null) {
        pen = false;
        return;
      }
      d += `${pen ? "L" : "M"}${xAt(i).toFixed(1)},${yAt(v).toFixed(1)} `;
      pen = true;
    });
    return d.trim();
  };

  // ~6 marcas no eixo X (evita amontoar 30/90 dias).
  const step = Math.max(1, Math.ceil(n / 6));
  const ticks = Array.from({ length: n }, (_, i) => i).filter(
    (i) => i % step === 0 || i === n - 1,
  );
  // Marcas do eixo Y: explícitas (yTicks) ou 0/meio/máx automático.
  const gridVals = yTicks ?? [0, maxV / 2, maxV];

  return (
    <svg viewBox={`0 0 ${W} ${height}`} className="w-full" role="img" aria-label="Gráfico de linha">
      {gridVals.map((gv) => {
        const y = yAt(gv);
        return (
          <g key={gv}>
            <line
              x1={padL}
              y1={y}
              x2={W - padR}
              y2={y}
              className="stroke-gray-200 dark:stroke-gray-800"
              strokeWidth={1}
            />
            <text x={padL - 6} y={y + 3} textAnchor="end" className="fill-gray-500 text-[10px]">
              {formatY(gv)}
            </text>
          </g>
        );
      })}
      {ticks.map((i) => (
        <text
          key={i}
          x={xAt(i)}
          y={height - 6}
          textAnchor="middle"
          className="fill-gray-500 text-[10px]"
        >
          {xLabels[i]}
        </text>
      ))}
      {series.map((s) => (
        <path
          key={s.label}
          d={pathOf(s.values)}
          fill="none"
          className={s.strokeCls}
          strokeWidth={1.75}
          strokeLinejoin="round"
          strokeLinecap="round"
        />
      ))}
      {series.map((s) =>
        s.values.map((v, i) =>
          v == null ? null : (
            <circle key={`${s.label}-${i}`} cx={xAt(i)} cy={yAt(v)} r={2} className={s.fillCls}>
              <title>{`${xLabels[i]} · ${s.label}: ${tip(v)}`}</title>
            </circle>
          ),
        ),
      )}
    </svg>
  );
}

function ChartLegend({ series }: { series: ChartSeries[] }) {
  return (
    <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-gray-500">
      {series.map((s) => (
        <span key={s.label} className="inline-flex items-center gap-1.5">
          <span className={`inline-block h-2 w-2 rounded-sm ${s.swatchCls}`} />
          {s.label}
        </span>
      ))}
    </div>
  );
}

const TS_RANGES: TimeseriesRange[] = ["7d", "30d", "90d"];

const VOLUME_META = [
  { key: "arrived", label: "A Sincronizar", strokeCls: "stroke-yellow-500", fillCls: "fill-yellow-500", swatchCls: "bg-yellow-500" },
  { key: "synced", label: "Sincronizada", strokeCls: "stroke-sky-500", fillCls: "fill-sky-500", swatchCls: "bg-sky-500" },
  { key: "imported", label: "Importada", strokeCls: "stroke-rps-olive-dark", fillCls: "fill-rps-olive-dark", swatchCls: "bg-rps-olive-dark" },
  { key: "import_ignored", label: "Ignorada", strokeCls: "stroke-gray-400", fillCls: "fill-gray-400", swatchCls: "bg-gray-400" },
] as const;

// Tendência ao longo do tempo (série temporal do tracker). Volume/dia (4 linhas
// com legenda clicável pra ligar/desligar séries) + latência/dia (p50/p95).
// Range 7/30/90d controla as 3 queries de uma vez. Bucket fixo em "day".
function PainelTrends() {
  const [range, setRange] = useState<TimeseriesRange>("30d");
  // Séries ocultas no gráfico de volume. O usuário pode desligar "Importada"
  // (que domina a escala) pra comparar as linhas menores.
  const [hiddenSeries, setHiddenSeries] = useState<Set<string>>(new Set());
  const toggleSeries = (label: string) =>
    setHiddenSeries((prev) => {
      const next = new Set(prev);
      if (next.has(label)) { next.delete(label); } else { next.add(label); }
      return next;
    });
  const q = useQuery({
    queryKey: ["xml", "timeseries", range],
    queryFn: () => xmlMetricsApi.timeseries(range, "day").then((r) => r.data),
    refetchInterval: 60_000,
    placeholderData: (prev) => prev,
  });

  const buckets = q.data?.buckets ?? [];
  const xLabels = buckets.map((b) => ddmm(b.date));

  const allVolumeSeries: ChartSeries[] = VOLUME_META.map((m) => ({
    label: m.label,
    strokeCls: m.strokeCls,
    fillCls: m.fillCls,
    swatchCls: m.swatchCls,
    values: buckets.map((b) => b[m.key]),
  }));
  // Séries visíveis (ocultas viram null → gap, não poluem a escala)
  const volumeSeries: ChartSeries[] = allVolumeSeries.map((s) =>
    hiddenSeries.has(s.label)
      ? { ...s, values: s.values.map(() => null) }
      : s,
  );

  const latSeries = (p50Key: keyof (typeof buckets)[number], p95Key: keyof (typeof buckets)[number]): ChartSeries[] => [
    { label: "p50", strokeCls: "stroke-rps-olive-dark", fillCls: "fill-rps-olive-dark", swatchCls: "bg-rps-olive-dark", values: buckets.map((b) => b[p50Key] as number | null) },
    { label: "p95", strokeCls: "stroke-amber-500", fillCls: "fill-amber-500", swatchCls: "bg-amber-500", values: buckets.map((b) => b[p95Key] as number | null) },
  ];
  const latArrivalSync = latSeries("lat_arrival_sync_p50_s", "lat_arrival_sync_p95_s");
  const latSyncImport = latSeries("lat_sync_import_p50_s", "lat_sync_import_p95_s");
  const latMax = (s: ChartSeries[]) =>
    Math.max(0, ...s.flatMap((x) => x.values).filter((v): v is number => v != null));

  const rangePills = (
    <div className="flex gap-1">
      {TS_RANGES.map((r) => (
        <button
          key={r}
          onClick={() => setRange(r)}
          className={`rounded-full px-2.5 py-0.5 text-xs font-medium transition-colors ${
            range === r
              ? "bg-rps-olive-dark text-white"
              : "bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-400 hover:bg-gray-200 dark:hover:bg-gray-700"
          }`}
        >
          {r}
        </button>
      ))}
    </div>
  );

  return (
    <>
      <PainelCard title="Volume por dia" action={rangePills} className="lg:col-span-2">
        {q.isError ? (
          <ErrorState onRetry={() => q.refetch()} />
        ) : q.isLoading ? (
          <Skeleton className="h-44 w-full" />
        ) : buckets.length === 0 ? (
          <EmptyState className="py-4">Sem dados no período.</EmptyState>
        ) : (
          <>
            <LineChart
              series={volumeSeries}
              xLabels={xLabels}
              formatY={(n) => fmtCompact(Math.round(n))}
              formatTip={(n) => fmtFull(Math.round(n))}
            />
            {/* Legenda clicável — ligar/desligar séries. "Importada" domina a
                escala; o usuário pode desligá-la pra comparar as menores. */}
            <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1">
              {allVolumeSeries.map((s) => {
                const off = hiddenSeries.has(s.label);
                return (
                  <button
                    key={s.label}
                    type="button"
                    onClick={() => toggleSeries(s.label)}
                    aria-pressed={!off}
                    title={off ? `Mostrar ${s.label}` : `Ocultar ${s.label}`}
                    className={`inline-flex items-center gap-1.5 text-xs transition-opacity ${off ? "opacity-40" : ""}`}
                  >
                    <span className={`inline-block h-2 w-2 rounded-sm ${off ? "bg-gray-300 dark:bg-gray-600" : s.swatchCls}`} />
                    <span className={off ? "text-gray-400 dark:text-gray-500 line-through" : "text-gray-500 dark:text-gray-400"}>
                      {s.label}
                    </span>
                  </button>
                );
              })}
            </div>
            <p className="mt-1 text-xs text-gray-500">
              Notas por dia em que cada etapa ocorreu (fluxo, não estoque). Clique na legenda pra ocultar séries.
            </p>
          </>
        )}
      </PainelCard>

      <PainelCard title="Latência chegada → sync (por dia)">
        {q.isError ? (
          <ErrorState onRetry={() => q.refetch()} />
        ) : q.isLoading ? (
          <Skeleton className="h-44 w-full" />
        ) : !chartHasData(latArrivalSync) ? (
          <EmptyState className="py-4">Sem transições no período.</EmptyState>
        ) : (
          <>
            <LineChart
              series={latArrivalSync}
              xLabels={xLabels}
              formatY={(n) => fmtDur(Math.round(n))}
              yTicks={niceDurationTicks(latMax(latArrivalSync))}
            />
            <ChartLegend series={latArrivalSync} />
            <p className="mt-1 text-xs text-gray-500">
              Reflete o backlog de sincronização. Os últimos dias podem ser parciais.
            </p>
          </>
        )}
      </PainelCard>

      <PainelCard title="Latência sync → importação (por dia)">
        {q.isError ? (
          <ErrorState onRetry={() => q.refetch()} />
        ) : q.isLoading ? (
          <Skeleton className="h-44 w-full" />
        ) : !chartHasData(latSyncImport) ? (
          <EmptyState className="py-4">Sem transições no período.</EmptyState>
        ) : (
          <>
            <LineChart
              series={latSyncImport}
              xLabels={xLabels}
              formatY={(n) => fmtDur(Math.round(n))}
              yTicks={niceDurationTicks(latMax(latSyncImport))}
            />
            <ChartLegend series={latSyncImport} />
            <p className="mt-1 text-xs text-gray-500">Os últimos dias podem ser parciais.</p>
          </>
        )}
      </PainelCard>
    </>
  );
}

// Badge "principal gargalo" — deriva o maior status de backlog da linha sem
// nova coluna. Só aparece quando há pendências reais. Transparente: o usuário
// consegue conferir o valor na aba Empresas.
function GargaloBadge({ e }: { e: EmpresaAgg }) {
  const candidates: { key: keyof EmpresaAgg; label: string }[] = [
    { key: "pending_import", label: "Aguardando importação" },
    { key: "arrived", label: "A sincronizar" },
    { key: "synced", label: "Sincronizada" },
  ];
  const best = candidates.reduce(
    (a, c) => ((e[c.key] as number) > (e[a.key] as number) ? c : a),
    candidates[0],
  );
  if ((e[best.key] as number) === 0) return null;
  return (
    <span className="text-[11px] text-gray-400 dark:text-gray-500">{best.label}</span>
  );
}

// Painel: visão de gráficos do tracker. Snapshot (overview + empresas) +
// tendência por dia (série temporal). Blocos: distribuição por status (barras
// clicáveis → filtra Notas), latências p50/p95 atuais, empresas com mais notas
// pendentes (barras clicáveis → drill-down) e os gráficos de tendência.
function PainelView({
  ov,
  loading,
  error,
  onRetry,
  onPickStatus,
  onDrillEmpresa,
}: {
  ov?: Overview;
  loading: boolean;
  error: boolean;
  onRetry: () => void;
  onPickStatus: (s: NotaStatus) => void;
  onDrillEmpresa: (row: EmpresaAgg) => void;
}) {
  const empresas = useQuery({
    queryKey: ["xml", "empresas", "painel"],
    queryFn: () => empresasApi.list({ limit: 0 }).then((r) => r.data),
    refetchInterval: 30_000,
  });

  // "imported" fica FORA das barras: é ordens de grandeza maior (milhões de
  // notas terminais) e achataria as demais. Plotamos o resto e mostramos o
  // total de importadas à parte. stuck/lost também saem (o backend nunca
  // produz, seriam barras zeradas — mesmo motivo dos filtros da aba Notas).
  const barStatuses = PAINEL_STATUSES.filter(
    (s) => s !== "imported" && s !== "stuck" && s !== "lost",
  );
  const counts = ov ? barStatuses.map((s) => ({ status: s, count: statusCount(ov, s) })) : [];
  const maxCount = Math.max(1, ...counts.map((c) => c.count));
  const importedTotal = ov ? ov.imported : 0;
  const grandTotal = ov ? PAINEL_STATUSES.reduce((a, s) => a + statusCount(ov, s), 0) : 0;

  const pend = (e: EmpresaAgg) => e.arrived + e.synced + e.pending_import + e.stuck;
  const topEmpresas = [...(empresas.data?.items ?? [])]
    .filter((e) => e.codigo_empresa != null && pend(e) > 0)
    .sort((a, b) => pend(b) - pend(a))
    .slice(0, 10);
  const maxPend = Math.max(1, ...topEmpresas.map(pend));
  const totalPend = topEmpresas.reduce((a, e) => a + pend(e), 0) || 1;

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <PainelCard title="Distribuição por status">
        {error ? (
          <ErrorState onRetry={onRetry} />
        ) : loading ? (
          <Skeleton className="h-40 w-full" />
        ) : grandTotal === 0 ? (
          <EmptyState className="py-4">Nenhuma nota rastreada.</EmptyState>
        ) : (
          <>
            {/* Importadas à parte (fora do eixo das barras) */}
            <button
              onClick={() => onPickStatus("imported")}
              title={`${fmtFull(importedTotal)} importadas — clique pra filtrar`}
              className="mb-3 flex w-full items-center justify-between rounded-md bg-rps-olive-soft px-3 py-2 text-left"
            >
              <span className="text-xs font-medium text-rps-olive-dark">Importadas (total)</span>
              <span className="text-base font-bold tabular-nums text-rps-olive-dark">
                {fmtCompact(importedTotal)}
              </span>
            </button>
            <ul className="space-y-2">
              {counts.map((c) => (
                <li key={c.status}>
                  <button
                    onClick={() => onPickStatus(c.status)}
                    className="flex w-full items-center gap-3 text-left"
                    title="Filtrar notas por este status"
                  >
                    <Badge
                      size="xs"
                      className={`${XML_STATUS_STYLE[c.status]} w-44 shrink-0 truncate text-center`}
                    >
                      {XML_STATUS_LABEL[c.status]}
                    </Badge>
                    <div className="h-2 flex-1 overflow-hidden rounded-full bg-gray-100 dark:bg-gray-800">
                      <div
                        className={`h-full rounded-full ${STATUS_BAR_FILL[c.status]}`}
                        style={{ width: `${(c.count / maxCount) * 100}%` }}
                      />
                    </div>
                    <span
                      title={fmtFull(c.count)}
                      className="w-14 shrink-0 cursor-help text-right text-sm font-medium tabular-nums text-gray-700 dark:text-gray-300"
                    >
                      {fmtCompact(c.count)}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
            <p className="mt-3 text-xs text-gray-500">
              {fmtCompact(grandTotal)} notas rastreadas (importadas à parte) · clique numa barra pra
              filtrar.
            </p>
          </>
        )}
      </PainelCard>

      <PainelCard title="Latências de processamento (30d)">
        {error ? (
          <ErrorState onRetry={onRetry} />
        ) : loading ? (
          <Skeleton className="h-40 w-full" />
        ) : (
          <div className="space-y-4">
            <LatencyRow
              label="Chegada → Sincronização"
              p50={ov?.lat_arrival_sync_p50_s}
              p95={ov?.lat_arrival_sync_p95_s}
            />
            <LatencyRow
              label="Sincronização → Importação"
              p50={ov?.lat_sync_import_p50_s}
              p95={ov?.lat_sync_import_p95_s}
            />
            <div className="grid grid-cols-2 gap-3 pt-1">
              <MiniStat label="Em trânsito" value={ov?.in_transit ?? 0} />
              <MiniStat label="Importadas hoje" value={ov?.imported_today ?? 0} tone="success" />
            </div>
            <p className="text-xs text-gray-400">
              Percentis das transições dos últimos 30 dias; exclui backfill histórico.
            </p>
          </div>
        )}
      </PainelCard>

      <PainelCard title="Empresas com mais notas pendentes" className="lg:col-span-2">
        {empresas.isError ? (
          <ErrorState onRetry={() => empresas.refetch()} />
        ) : empresas.isLoading ? (
          <Skeleton className="h-48 w-full" />
        ) : topEmpresas.length === 0 ? (
          <EmptyState className="py-4">Nenhuma empresa com notas pendentes. 🎉</EmptyState>
        ) : (
          <ul className="space-y-2">
            {topEmpresas.map((e) => (
              <li key={`${e.codigo_empresa}-${e.codigo_filial ?? "x"}`}>
                <button
                  onClick={() => onDrillEmpresa(e)}
                  className="flex w-full items-center gap-3 text-left"
                  title="Ver notas desta empresa"
                >
                  <span className="min-w-0 flex-1 space-y-0.5">
                    <span
                      className="block truncate text-sm text-gray-700 dark:text-gray-300"
                      title={e.nome_empresa}
                    >
                      {e.nome_empresa || `#${e.codigo_empresa}-${e.codigo_filial ?? 1}`}
                    </span>
                    <GargaloBadge e={e} />
                  </span>
                  <div className="h-2.5 flex-1 overflow-hidden rounded-full bg-gray-100 dark:bg-gray-800">
                    <div
                      className="h-full rounded-full bg-rps-olive-dark"
                      style={{ width: `${(pend(e) / maxPend) * 100}%` }}
                    />
                  </div>
                  <span
                    title={fmtFull(pend(e))}
                    className="w-14 shrink-0 cursor-help text-right text-sm font-medium tabular-nums text-gray-700 dark:text-gray-300"
                  >
                    {fmtCompact(pend(e))}
                  </span>
                  <span className="w-10 shrink-0 text-right text-xs text-gray-400 tabular-nums">
                    {Math.round((pend(e) / totalPend) * 100)}%
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </PainelCard>

      <PainelTrends />
    </div>
  );
}

type EmpSortKey = "pendentes" | "arrived" | "synced" | "pending_import" | "stuck" | "lost" | "imported";

// Colunas numéricas da tabela de Empresas, com rótulo curto + tooltip (o
// cabeçalho é abreviado por espaço) + tom de cor. Ordem = ordem na tabela.
const EMP_COLS: { key: EmpSortKey; label: string; title: string; tone?: "danger" | "warn" }[] = [
  { key: "pendentes", label: "Pendentes", title: "Chegou + sincronizado + aguardando + travada" },
  { key: "arrived", label: "A sinc.", title: "A sincronizar", tone: "warn" },
  { key: "synced", label: "Sincr.", title: "Sincronizadas" },
  { key: "pending_import", label: "Aguard.", title: "Aguardando importação" },
  { key: "stuck", label: "Travadas", title: "Travadas", tone: "danger" },
  { key: "lost", label: "Sumidas", title: "Sumidas", tone: "danger" },
  { key: "imported", label: "Importadas", title: "Importadas (acumulado histórico)" },
];

function empValue(e: EmpresaAgg, key: EmpSortKey): number {
  if (key === "pendentes") return e.arrived + e.synced + e.pending_import + e.stuck;
  return e[key];
}

// Visão por empresa: uma linha por (empresa, filial) + a linha "Sem empresa"
// (sempre fixada por último). Ordenável por qualquer coluna numérica (default
// pendentes desc). Drill-down reusa os filtros de URL da aba Notas.
function EmpresasView({ onDrill }: { onDrill: (row: EmpresaAgg) => void }) {
  const [search, setSearch] = useState("");
  const debounced = useDebounced(search.trim(), 300);
  const q = useQuery({
    // Busca por nome via API (?q=, parcial/case-insensitive). Mantém limit:0
    // (todas as linhas) + sort/paginação client-side de sempre.
    queryKey: ["xml", "empresas", debounced],
    queryFn: () => empresasApi.list({ limit: 0, q: debounced || undefined }).then((r) => r.data),
    refetchInterval: 30_000,
    placeholderData: (prev) => prev,
  });

  const [sort, setSort] = useState<{ key: EmpSortKey; dir: "asc" | "desc" }>({
    key: "pendentes",
    dir: "desc",
  });
  const toggleSort = (key: EmpSortKey) =>
    setSort((s) => (s.key === key ? { key, dir: s.dir === "desc" ? "asc" : "desc" } : { key, dir: "desc" }));

  const pend = (e: EmpresaAgg) => e.arrived + e.synced + e.pending_import + e.stuck;
  const rows = [...(q.data?.items ?? [])].sort((a, b) => {
    const aNo = a.codigo_empresa == null;
    const bNo = b.codigo_empresa == null;
    if (aNo !== bNo) return aNo ? 1 : -1; // "Sem empresa" sempre por último
    const diff = empValue(b, sort.key) - empValue(a, sort.key);
    return sort.dir === "desc" ? diff : -diff;
  });

  const numCols = 2 + EMP_COLS.length; // Empresa + colunas numéricas + chevron
  const cell = (n: number, tone?: "danger" | "warn") =>
    n === 0 ? (
      <span className="text-gray-300 dark:text-gray-600">0</span>
    ) : (
      <span
        title={fmtFull(n)}
        className={`cursor-help ${tone === "danger" ? "font-medium text-red-600 dark:text-red-400" : tone === "warn" ? "text-amber-700 dark:text-amber-400" : ""}`}
      >
        {fmtCompact(n)}
      </span>
    );

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Buscar empresa por nome…"
          className="w-72 rounded border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-900 px-3 py-1.5 text-sm placeholder-gray-500 focus:border-rps-olive-dark focus:outline-none"
        />
        <span className="text-sm text-gray-500">
          {q.isFetching ? "Atualizando…" : `${rows.length} empresa${rows.length === 1 ? "" : "s"}`}
        </span>
      </div>
      <Table stickyHeader>
      <THead sticky>
        <Th>Empresa</Th>
        {EMP_COLS.map((col) => {
          const active = sort.key === col.key;
          return (
            <Th key={col.key} className="text-right">
              <button
                type="button"
                onClick={() => toggleSort(col.key)}
                title={col.title}
                className={`ml-auto inline-flex items-center gap-1 uppercase tracking-wider ${active ? "text-gray-700 dark:text-gray-200" : "hover:text-gray-700 dark:hover:text-gray-300"}`}
              >
                {col.label}
                {active ? (
                  sort.dir === "desc" ? (
                    <ChevronDown className="h-3 w-3" aria-hidden />
                  ) : (
                    <ChevronUp className="h-3 w-3" aria-hidden />
                  )
                ) : null}
              </button>
            </Th>
          );
        })}
        <Th className="w-8" aria-label="Abrir" />
      </THead>
      <TBody>
        {rows.map((e) => {
          const isNoEmpresa = e.codigo_empresa == null;
          return (
            <Tr
              key={isNoEmpresa ? "sem-empresa" : `${e.codigo_empresa}-${e.codigo_filial ?? "x"}`}
              className="group cursor-pointer"
              title="Ver notas desta empresa"
              onClick={() => onDrill(e)}
            >
              <Td className="max-w-[280px] truncate text-gray-700 dark:text-gray-300" title={e.nome_empresa}>
                {isNoEmpresa ? (
                  <span className="italic text-gray-500">Sem empresa</span>
                ) : (
                  e.nome_empresa || `#${e.codigo_empresa}-${e.codigo_filial ?? 1}`
                )}
              </Td>
              {EMP_COLS.map((col) =>
                col.key === "pendentes" ? (
                  <Td key={col.key} className="text-right font-semibold text-gray-900 dark:text-gray-100">
                    <span title={fmtFull(pend(e))} className="cursor-help">{fmtCompact(pend(e))}</span>
                  </Td>
                ) : col.key === "imported" ? (
                  <Td key={col.key} className="text-right text-gray-500">
                    <span title={fmtFull(e.imported)} className="cursor-help">{fmtCompact(e.imported)}</span>
                  </Td>
                ) : (
                  <Td key={col.key} className="text-right">
                    {cell(empValue(e, col.key), col.tone)}
                  </Td>
                ),
              )}
              <Td className="text-right">
                <ChevronRight
                  className="ml-auto h-4 w-4 text-gray-300 transition group-hover:text-rps-olive-dark dark:text-gray-600"
                  aria-hidden
                />
              </Td>
            </Tr>
          );
        })}
        {q.isError && rows.length === 0 && <ErrorRow colSpan={numCols} onRetry={() => q.refetch()} />}
        {!q.isLoading && !q.isError && rows.length === 0 && (
          <EmptyRow colSpan={numCols}>
            {debounced
              ? `Nenhuma empresa encontrada para “${debounced}”.`
              : "Nenhuma empresa com notas rastreadas."}
          </EmptyRow>
        )}
        {q.isLoading && Array.from({ length: 8 }).map((_, i) => <SkeletonRow key={i} cols={numCols} />)}
      </TBody>
      </Table>
    </div>
  );
}

const STAGE_LABEL: Record<string, string> = {
  arrival: "Chegada",
  sync: "Sincronização",
  import: "Importação",
};

// Rótulos legíveis de event_type na timeline. `seen_pending` NÃO é importação —
// é o Athenas ter enxergado a nota (ainda falta importar); rotular como estágio
// "Aguardando importação" evita a leitura errada de "já importada".
const EVENT_LABEL: Record<string, string> = {
  seen_pending: "visto no Athenas",
};

function spanLabels(s: { stage: string; event_type: string }): { stage: string; event: string } {
  if (s.event_type === "seen_pending") {
    return { stage: "Aguardando importação", event: EVENT_LABEL.seen_pending };
  }
  return {
    stage: STAGE_LABEL[s.stage] ?? s.stage,
    event: EVENT_LABEL[s.event_type] ?? s.event_type,
  };
}

function NotaDetailModal({ chave, onClose }: { chave: string; onClose: () => void }) {
  const { data, isLoading, isError } = useQuery({
    queryKey: ["xml", "nota", chave],
    queryFn: () => notasApi.get(chave).then((r) => r.data),
  });

  return (
    <Modal title="Nota fiscal" onClose={onClose} wide>
      <p className="mb-4 break-all font-mono text-xs text-gray-500">{chave}</p>

      {isLoading && <Skeleton className="h-32 w-full" />}
      {isError && <p className="text-sm text-red-600">Falha ao carregar a nota.</p>}

      {data && (
        <>
          <div className="mb-5 grid grid-cols-2 gap-3 text-sm sm:grid-cols-3">
            <Field label="Tipo" value={XML_DOC_TYPE_LABEL[data.doc_type]} />
            <Field label="Status">
              <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${XML_STATUS_STYLE[data.status]}`}>
                {XML_STATUS_LABEL[data.status]}
              </span>
            </Field>
            <Field label="Empresa" value={data.nome_empresa || (data.codigo_empresa ? `#${data.codigo_empresa}-${data.codigo_filial ?? 1}` : "—")} />
            <Field label="Emissão" value={data.data_emissao ?? "—"} />
            <Field label="Valor" value={data.valor_total != null ? fmtBRL(data.valor_total) : "—"} />
            <Field label="Emitente" value={fmtParty(data.nome_emitente, data.cnpj_emitente)} />
            <Field label="Destinatário" value={fmtParty(data.nome_destinatario, data.cnpj_destinatario)} />
            <Field label="Latência chegada→sync" value={fmtDur(data.lat_arrival_sync_s)} />
            <Field label="Latência sync→import" value={fmtDur(data.lat_sync_import_s)} />
          </div>

          {data.motivo_ignorado && (
            <div className="mb-5 rounded border border-gray-200 dark:border-gray-800 bg-gray-50 dark:bg-gray-800 p-3 text-xs text-gray-600 dark:text-gray-400">
              <b>Motivo da importação ignorada:</b> {data.motivo_ignorado}
            </div>
          )}

          <h3 className="mb-2 text-sm font-semibold text-gray-700 dark:text-gray-300">Linha do tempo</h3>
          <ol className="relative space-y-3 border-l border-gray-200 pl-5 dark:border-gray-700">
            {data.spans.length === 0 && <li className="text-sm text-gray-500">Sem eventos.</li>}
            {data.spans.map((s, i) => {
              const l = spanLabels(s);
              return (
                <li key={i} className="relative">
                  <span className="absolute -left-[23px] top-1 h-2.5 w-2.5 rounded-full bg-rps-olive-dark" />
                  <p className="text-sm font-medium text-gray-800 dark:text-gray-200">
                    {l.stage} <span className="text-xs font-normal text-gray-500">· {l.event}</span>
                  </p>
                  <p className="text-xs text-gray-500">{fmtTs(s.observed_at)} · {s.source}</p>
                  {s.file_path && <p className="break-all text-[11px] text-gray-400">{s.file_path}</p>}
                </li>
              );
            })}
          </ol>
        </>
      )}
    </Modal>
  );
}

function Field({ label, value, children }: { label: string; value?: string; children?: ReactNode }) {
  return (
    <div>
      <p className="text-xs font-medium uppercase tracking-wider text-gray-400">{label}</p>
      <div className="mt-0.5 text-gray-800 dark:text-gray-200">{children ?? value}</div>
    </div>
  );
}
