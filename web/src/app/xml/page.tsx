"use client";

import { Fragment, Suspense, useEffect, useState, type ReactNode } from "react";
import { useSearchParams } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { format } from "date-fns";
import { AlertTriangle, X, Copy, Check, ChevronRight, ChevronDown, ChevronUp, Bot, RadioTower, Info, Download, ArrowDownLeft, ArrowUpRight, Monitor, Maximize2 } from "lucide-react";
import Link from "next/link";
import { toast } from "sonner";
import {
  notasApi,
  xmlMetricsApi,
  empresasApi,
  xmlStatusApi,
  type PollerPayload,
  XML_STATUS_LABEL,
  XML_STATUS_STYLE,
  XML_DOC_TYPE_LABEL,
  type Nota,
  type NotaListFilter,
  type NotaStatus,
  type DocType,
  type Direction,
  type DateField,
  type EmpresaAgg,
  type Overview,
  type Aging,
  type AgingBucket,
  type Timeseries,
  type TimeseriesRange,
  type LatencyMetrics,
  type Participacao,
} from "@/lib/xml-api";
import { toCsv, downloadCsv } from "@/lib/csv";
import { Modal } from "@/components/ui/modal";
import { Skeleton, SkeletonRow } from "@/components/skeleton";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Table, THead, Th, TBody, Tr, Td } from "@/components/ui/table";
import { EmptyRow, EmptyState } from "@/components/ui/empty-state";
import { ErrorRow, ErrorState } from "@/components/ui/error-state";

const PAGE_SIZE = 50;

// Filtros carregados no drill-down Empresas → Notas (mantém a consistência
// entre as abas): janela de data + tipo de documento + direção.
type DrillFilters = {
  dateField: DateField;
  from: string;
  to: string;
  docFilter: DocType | "all";
  direction: Direction | "all";
};

// Seletor de período dos cards (item #5). "all" = snapshot do estado atual;
// os demais aplicam uma janela (modo flow: contagens do recorte, não estoque).
type CardRange = "all" | "today" | "7d" | "30d";
const CARD_RANGES: { value: CardRange; label: string }[] = [
  { value: "all", label: "Tudo" },
  { value: "today", label: "Hoje" },
  { value: "7d", label: "7 dias" },
  { value: "30d", label: "30 dias" },
];
const DATE_FIELD_LABEL: Record<DateField, string> = {
  emissao: "emissão",
  arrived: "chegada",
  synced: "sincronização",
  imported: "importação",
};
// Subtrai dias de um ISO date (yyyy-mm-dd). Determinística (não usa relógio em
// render — recebe a data-base pronta), então não cai na regra de pureza.
function subDaysIso(iso: string, n: number): string {
  const d = new Date(iso + "T00:00:00");
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
}

// Status filtráveis = as etapas reais do pipeline. ("Travada"/"Sumida" foram
// removidos do produto: o backend nunca os produzia.)
const STATUS_FILTERS: { value: NotaStatus | "all"; label: string }[] = [
  { value: "all", label: "Todos" },
  { value: "arrived", label: "A Sincronizar" },
  { value: "synced", label: "Sincronizada" },
  { value: "pending_import", label: "Aguardando Importação" },
  { value: "imported", label: "Importada" },
  { value: "import_ignored", label: "Ignorada" },
];

const DOC_TYPES: (DocType | "all")[] = ["all", "NFE", "NFCE", "CTE", "NFS"];

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

// Copia texto para a área de transferência. navigator.clipboard só funciona em
// HTTPS; usa o fallback de execCommand em HTTP (produção interna). O textarea
// temporário do fallback entra dentro de `host` (não sempre document.body):
// diálogos Radix (Modal) fazem focus-trap e puxam o foco de volta pra dentro
// do Dialog.Content se ele "escapa" pra um elemento fora da subtree — o que
// quebra o .focus()/execCommand se o textarea nascer direto no body.
function copyText(text: string, host: HTMLElement = document.body): Promise<void> {
  if (typeof navigator !== "undefined" && navigator.clipboard) {
    return navigator.clipboard.writeText(text);
  }
  return new Promise((resolve, reject) => {
    const el = document.createElement("textarea");
    el.value = text;
    el.style.cssText = "position:fixed;top:0;left:0;opacity:0";
    host.appendChild(el);
    el.focus();
    el.select();
    try {
      if (document.execCommand("copy")) { resolve(); } else { reject(new Error("execCommand failed")); }
    } catch (e) {
      reject(e);
    } finally {
      host.removeChild(el);
    }
  });
}

// Overlay de carregamento sobre uma tabela com placeholderData. Mantém os dados
// antigos visíveis mas com opacidade reduzida + spinner, indicando atualização.
// Não aparece no primeiro load (isLoading) — nesses casos os SkeletonRows já
// cuidam. Só aparece em re-fetches com dados anteriores presentes (isFetching).
function TableLoadingOverlay({ isFetching }: { isFetching: boolean }) {
  if (!isFetching) return null;
  return (
    <div
      className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center rounded-lg bg-white/60 dark:bg-gray-900/60"
      aria-hidden
    >
      <div className="flex items-center gap-2 rounded-full bg-white dark:bg-gray-900 px-3 py-1.5 shadow-md">
        <svg
          className="h-4 w-4 animate-spin text-rps-olive-dark"
          fill="none"
          viewBox="0 0 24 24"
        >
          <circle
            className="opacity-25"
            cx="12" cy="12" r="10"
            stroke="currentColor"
            strokeWidth="4"
          />
          <path
            className="opacity-75"
            fill="currentColor"
            d="M4 12a8 8 0 018-8v4l3-3-3-3v4a8 8 0 00-8 8h4z"
          />
        </svg>
        <span className="text-xs font-medium text-rps-olive-dark">Atualizando…</span>
      </div>
    </div>
  );
}

// Botão de copiar (ação passiva). Mostra "Copiado" por ~1.5s após sucesso.
function CopyButton({ text, label }: { text: string; label: string }) {
  const [done, setDone] = useState(false);
  const copy = (e: React.MouseEvent<HTMLButtonElement>) => {
    e.stopPropagation();
    copyText(text, e.currentTarget.parentElement ?? document.body)
      .then(() => {
        setDone(true);
        setTimeout(() => setDone(false), 1500);
      })
      .catch(() => {/* silencia — nada a fazer */});
  };
  return (
    <button
      type="button"
      onClick={copy}
      title={`Copiar ${label}`}
      aria-label={`Copiar ${label}`}
      className={`inline-flex shrink-0 items-center gap-1 rounded px-1 py-0.5 text-xs transition
        ${done
          ? "text-rps-olive-dark"
          : "text-gray-400 opacity-0 hover:text-rps-olive-dark focus:opacity-100 group-hover:opacity-100"
        }`}
    >
      {done ? (
        <>
          <Check className="h-3.5 w-3.5" aria-hidden />
          <span className="font-medium">Copiado</span>
        </>
      ) : (
        <Copy className="h-3.5 w-3.5" aria-hidden />
      )}
    </button>
  );
}

// Badge "via robô / manual" — só aparece em notas com status imported.
// via_robo undefined = campo não presente (status ≠ imported), não renderiza.
function ViaRoboBadge({ via_robo }: { via_robo?: boolean }) {
  if (!via_robo) return null;
  return (
    <span className="inline-flex items-center gap-1 rounded bg-gray-200 px-1.5 py-0.5 text-[11px] font-medium text-gray-700 dark:bg-gray-700 dark:text-gray-300">
      <Bot className="h-3 w-3" aria-hidden /> Robô
    </span>
  );
}

// Badge de direção (entrada/saída relativa à empresa). Omitido quando o tracker
// não determinou a direção (sem empresa / CNPJ sem match).
function DirectionBadge({ direction }: { direction?: Direction }) {
  if (!direction) return null;
  const entrada = direction === "entrada";
  return (
    <span
      className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] font-medium ${
        entrada
          ? "bg-sky-100 text-sky-700 dark:bg-sky-900/40 dark:text-sky-300"
          : "bg-purple-100 text-purple-700 dark:bg-purple-900/40 dark:text-purple-300"
      }`}
    >
      {entrada ? <ArrowDownLeft className="h-3 w-3" aria-hidden /> : <ArrowUpRight className="h-3 w-3" aria-hidden />}
      {entrada ? "Entrada" : "Saída"}
    </span>
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
      className={`rounded-lg border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 px-4 py-3 shadow-sm${title ? " cursor-help" : ""}`}
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

// ── SLA de latência ───────────────────────────────────────────────────────────
// Semáforo das latências de processamento (decisão do Enzzo 2026-06-29):
// verde < 24h · amarelo 24–72h · vermelho > 72h. Mesmos limiares nas duas
// transições (chegada→sync e sync→import).
const SLA_WARN_S = 24 * 3600;
const SLA_CRIT_S = 72 * 3600;
type SlaTone = "ok" | "warn" | "crit" | "none";
function slaTone(s?: number): SlaTone {
  if (s == null) return "none";
  if (s < SLA_WARN_S) return "ok";
  if (s < SLA_CRIT_S) return "warn";
  return "crit";
}
const SLA_DOT: Record<SlaTone, string> = {
  ok: "bg-green-500",
  warn: "bg-amber-500",
  crit: "bg-red-500",
  none: "bg-gray-300 dark:bg-gray-600",
};
const SLA_VALUE: Record<SlaTone, string> = {
  ok: "text-green-700 dark:text-green-400",
  warn: "text-amber-700 dark:text-amber-400",
  crit: "text-red-700 dark:text-red-400",
  none: "text-gray-500",
};

// Tile de latência da manchete: p50 grande com cor de SLA + dot, p95 embaixo.
// O p50 é a métrica que decide a cor (mediana = experiência típica).
// ── Latência do pipeline (endpoint novo /metrics/latency) ─────────────────────
// Humanização pedida: <90min = minutos; <48h = horas; senão dias (1 casa).
function fmtLatHuman(s: number): string {
  if (s < 90 * 60) return `${Math.round(s / 60)} min`;
  if (s < 48 * 3600) return `${Math.round(s / 3600)}h`;
  return `${(s / 86400).toLocaleString("pt-BR", { minimumFractionDigits: 1, maximumFractionDigits: 1 })} dias`;
}
function fmtPct1(n: number): string {
  return n.toLocaleString("pt-BR", { maximumFractionDigits: 1 });
}

// Dois tiles novos (fragmento p/ entrar na grade da manchete): fila de
// sincronização (p50/p95 + mini-barras diárias) e importação pós-sync (%).
function LatencyCards() {
  const q = useQuery({
    queryKey: ["xml", "latency", 7],
    queryFn: () => xmlMetricsApi.latency(7).then((r) => r.data),
    refetchInterval: 60_000,
  });
  const a2s = q.data?.arrival_to_sync;
  const s2i = q.data?.sync_to_import;

  const tile = (title: string, body: ReactNode) => (
    <div className="rounded-lg border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 p-3 shadow-sm">
      <p className="text-xs font-medium uppercase tracking-wider text-gray-500">{title}</p>
      <div className="mt-1">{body}</div>
    </div>
  );

  let body1: ReactNode;
  if (q.isLoading) body1 = <Skeleton className="h-9 w-32" />;
  else if (q.isError) body1 = <ErrorState onRetry={() => q.refetch()} />;
  else if (!a2s || a2s.count === 0 || a2s.p50_s == null) body1 = <span className="text-sm text-gray-400">sem dados na janela</span>;
  else {
    const tone = slaTone(a2s.p50_s);
    const daily = a2s.daily.filter((d) => d.p50_s != null);
    const maxP50 = Math.max(1, ...daily.map((d) => d.p50_s as number));
    body1 = (
      <>
        <div className="flex flex-wrap items-baseline gap-x-2">
          <span className={`inline-block h-2.5 w-2.5 shrink-0 self-center rounded-full ${SLA_DOT[tone]}`} aria-hidden />
          <span className={`text-2xl font-bold ${SLA_VALUE[tone]}`}>{fmtLatHuman(a2s.p50_s)}</span>
          <span className="text-xs text-gray-500">p50 · p95: {a2s.p95_s != null ? fmtLatHuman(a2s.p95_s) : "—"}</span>
        </div>
        <p className="mt-0.5 text-xs text-gray-500">{fmtFull(a2s.count)} notas sincronizadas nos últimos 7 dias</p>
        {daily.length > 1 && (
          <div className="mt-2 flex h-6 items-end gap-0.5" aria-hidden>
            {daily.map((d) => (
              <div
                key={d.date}
                title={`${d.date}: p50 ${fmtLatHuman(d.p50_s as number)}`}
                className="flex-1 rounded-sm bg-rps-sage-soft"
                style={{ height: `${Math.max(4, ((d.p50_s as number) / maxP50) * 100)}%` }}
              />
            ))}
          </div>
        )}
      </>
    );
  }

  let body2: ReactNode;
  if (q.isLoading) body2 = <Skeleton className="h-9 w-32" />;
  else if (q.isError) body2 = <ErrorState onRetry={() => q.refetch()} />;
  else if (!s2i || s2i.count === 0) body2 = <span className="text-sm text-gray-400">sem dados na janela</span>;
  else {
    const good = s2i.same_day_pct >= 95;
    body2 = (
      <>
        <div className="flex flex-wrap items-baseline gap-x-2">
          <span className={`inline-block h-2.5 w-2.5 shrink-0 self-center rounded-full ${good ? "bg-green-500" : "bg-amber-500"}`} aria-hidden />
          <span className={`text-2xl font-bold ${good ? "text-green-700 dark:text-green-400" : "text-amber-600 dark:text-amber-400"}`}>{fmtPct1(s2i.same_day_pct)}%</span>
          <span className="text-xs text-gray-500">no mesmo dia</span>
        </div>
        <p className="mt-0.5 text-xs text-gray-500" title={`D+1: ${fmtFull(s2i.d1)} · D+2 ou mais: ${fmtFull(s2i.d2_plus)} de ${fmtFull(s2i.count)}`}>
          D+1: {fmtFull(s2i.d1)} · D+2+: {fmtFull(s2i.d2_plus)} de {fmtFull(s2i.count)}
        </p>
      </>
    );
  }

  return (
    <>
      {tile("Fila de sincronização (7d)", body1)}
      {tile("Importação pós-sync (7d)", body2)}
    </>
  );
}

// ── Glossário dos estados ─────────────────────────────────────────────────────
// Explica cada status em linguagem do fiscal — sem depender de hover/tooltip.
const STATUS_GLOSSARY: { status: NotaStatus; desc: string }[] = [
  { status: "arrived", desc: "Chegou ao tracker (arquivo XML detectado), mas ainda não foi sincronizada." },
  { status: "synced", desc: "Sincronizada; aguardando ser vista no Athenas para importar." },
  { status: "pending_import", desc: "Já vista no Athenas, ainda não importada." },
  { status: "imported", desc: "Importada no Athenas (por robô ou manualmente)." },
  { status: "import_ignored", desc: "Marcada para não ser importada — o motivo aparece no detalhe da nota." },
];

function StatusGlossary() {
  return (
    <div className="rounded-lg border border-gray-200 dark:border-gray-800 bg-gray-50 dark:bg-gray-900/50 p-3">
      <ul className="space-y-1.5">
        {STATUS_GLOSSARY.map((g) => (
          <li key={g.status} className="flex items-start gap-2 text-sm">
            <Badge className={`${XML_STATUS_STYLE[g.status]} shrink-0`}>{XML_STATUS_LABEL[g.status]}</Badge>
            <span className="text-gray-600 dark:text-gray-400">{g.desc}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

// ── Acurácia do import (reconciliação Athenas ↔ tracker, 24h) ─────────────────
const ACCURACY_STALE_MS = 90 * 60 * 1000;

// 2 casas só quando ≠ 100 ("100%" seco lê melhor que "100,00%").
function fmtAccuracyPct(pct: number): string {
  return pct >= 100 ? "100%" : `${pct.toFixed(2)}%`;
}
function fmtAgoMin(ms: number): string {
  const min = Math.round(ms / 60000);
  if (min < 1) return "agora mesmo";
  if (min < 60) return `há ${min} min`;
  const h = Math.floor(min / 60);
  const r = min % 60;
  return r ? `há ${h}h ${r}min` : `há ${h}h`;
}

// Card de acurácia do import: lê o payload do poller no /status. Estados:
// carregando / API-erro / stale / erro-de-ciclo / divergência / ok(+self-heal).
function AccuracyCard() {
  const [now, setNow] = useState(() => Date.now());
  const [showSample, setShowSample] = useState(false);
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);
  const q = useQuery({
    queryKey: ["xml", "status", "accuracy"],
    queryFn: () => xmlStatusApi.get().then((r) => r.data),
    refetchInterval: 60_000,
  });

  const poller = q.data?.services.find((s) => s.service === "poller");
  const p = poller?.payload as PollerPayload | undefined;
  const reconcileAtMs = p?.reconcile_at ? new Date(p.reconcile_at).getTime() : null;
  const hasReconcile = p != null && p.reconcile_athenas != null && reconcileAtMs != null;
  // Stale: poller ausente/offline, sem campos de reconcile, ou medição velha (>90min).
  const stale =
    !q.isLoading &&
    !q.isError &&
    (!poller || !poller.online || !hasReconcile || (reconcileAtMs != null && now - reconcileAtMs > ACCURACY_STALE_MS));

  const shell = (children: ReactNode) => (
    <div className="rounded-lg border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 p-3 shadow-sm">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs font-medium uppercase tracking-wider text-gray-500">Acurácia do import (24h)</p>
        {hasReconcile && !stale && reconcileAtMs != null && (
          <span className="text-[11px] text-gray-400">atualizado {fmtAgoMin(now - reconcileAtMs)}</span>
        )}
      </div>
      <div className="mt-2">{children}</div>
    </div>
  );

  if (q.isLoading) return shell(<Skeleton className="h-9 w-40" />);
  if (q.isError) return shell(<ErrorState onRetry={() => q.refetch()} />);
  if (stale) {
    return shell(
      <div className="flex flex-wrap items-baseline gap-x-2">
        <span className="text-2xl font-bold text-gray-400">Sem dados recentes</span>
        {reconcileAtMs != null && <span className="text-xs text-gray-500">última medição {fmtAgoMin(now - reconcileAtMs)}</span>}
      </div>,
    );
  }

  const pd = p as PollerPayload;
  if (pd.reconcile_error) {
    return shell(
      <div className="rounded border border-red-200 bg-red-50 p-2.5 text-sm text-red-700 dark:border-red-900/50 dark:bg-red-950/30 dark:text-red-300">
        <b>Falha no último ciclo:</b> {pd.reconcile_error}
      </div>,
    );
  }

  const missing = pd.reconcile_missing ?? 0;
  const fixed = pd.reconcile_fixed ?? 0;
  const athenas = pd.reconcile_athenas ?? 0;
  const pct = pd.reconcile_accuracy_pct ?? (athenas > 0 ? (100 * (athenas - missing)) / athenas : 100);
  const sample = pd.reconcile_missing_sample ?? [];

  if (missing > 0) {
    const bad = pct < 99;
    return shell(
      <>
        <div className="flex flex-wrap items-baseline gap-x-2">
          <span className={`inline-block h-2.5 w-2.5 shrink-0 self-center rounded-full ${bad ? "bg-red-500" : "bg-amber-500"}`} aria-hidden />
          <span className={`text-2xl font-bold ${bad ? "text-red-600 dark:text-red-400" : "text-amber-600 dark:text-amber-400"}`}>{fmtAccuracyPct(pct)}</span>
          <span className="text-sm text-gray-500">faltam {fmtFull(missing)} de {fmtFull(athenas)} nota{athenas === 1 ? "" : "s"}</span>
        </div>
        {sample.length > 0 && (
          <div className="mt-2">
            <button type="button" onClick={() => setShowSample((v) => !v)} className="text-xs text-gray-500 hover:text-rps-olive-dark">
              {showSample ? "Ocultar" : "Ver"} chaves faltantes ({sample.length})
            </button>
            {showSample && (
              <ul className="mt-1.5 space-y-1">
                {sample.map((k) => (
                  <li key={k} className="flex items-center gap-1.5">
                    <span className="truncate font-mono text-xs text-gray-600 dark:text-gray-400">{k}</span>
                    <CopyButton text={k} label="chave" />
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </>,
    );
  }

  // OK (missing == 0) — com ou sem self-heal neste ciclo.
  return shell(
    <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
      <span className="inline-block h-2.5 w-2.5 shrink-0 self-center rounded-full bg-green-500" aria-hidden />
      <span className="text-2xl font-bold text-green-700 dark:text-green-400">{fmtAccuracyPct(pct)}</span>
      <span className="text-sm text-gray-500">{fmtFull(athenas)} nota{athenas === 1 ? "" : "s"} conferida{athenas === 1 ? "" : "s"} com o Athenas</span>
      {fixed > 0 && (
        <span
          className="ml-1 rounded-full bg-sky-100 px-2 py-0.5 text-[11px] font-medium text-sky-700 dark:bg-sky-900/40 dark:text-sky-300"
          title="Self-heal: o tracker detectou e corrigiu sozinho a divergência neste ciclo"
        >
          {fmtFull(fixed)} corrigida{fixed === 1 ? "" : "s"} automaticamente neste ciclo
        </span>
      )}
    </div>,
  );
}

function fmtTs(s?: string): string {
  return s ? format(new Date(s), "dd/MM/yyyy HH:mm:ss") : "—";
}

// Data (sem hora) — reformata "YYYY-MM-DD[...]" direto pra dd/MM/yyyy, sem passar
// por Date (evita o deslize de fuso que jogaria a meia-noite UTC pro dia anterior).
function fmtDateOnly(s?: string): string {
  if (!s) return "—";
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (m) return `${m[3]}/${m[2]}/${m[1]}`;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? s : format(d, "dd/MM/yyyy");
}

// ── Exportação CSV ────────────────────────────────────────────────────────────
// Teto de linhas por exportação de notas. É client-side (puxa o conjunto numa
// requisição só), então limitamos pra não derrubar o navegador num filtro amplo
// — e avisamos quando trunca (sem corte silencioso).
const EXPORT_CAP = 50_000;

// Timestamp pro nome do arquivo (em handler, não em render → new Date() ok).
function fileStamp(): string {
  return new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
}

// Timestamp formatado pro CSV, vazio (não "—") quando ausente.
function csvTs(s?: string): string {
  return s ? fmtTs(s) : "";
}

const NOTA_CSV_HEADERS = [
  "Chave de acesso", "Número", "Tipo", "Status", "Empresa", "Cód. empresa",
  "Cód. filial", "Emitente", "CNPJ emitente", "Destinatário", "CNPJ destinatário",
  "Valor", "Emissão", "Chegada", "Sincronização", "Importação", "Via robô",
  "Motivo ignorada",
];

function notaToCsvRow(n: Nota): (string | number | null)[] {
  return [
    n.chave_acesso,
    n.numero_nota ?? "",
    XML_DOC_TYPE_LABEL[n.doc_type],
    XML_STATUS_LABEL[n.status],
    n.nome_empresa ?? "",
    n.codigo_empresa ?? "",
    n.codigo_filial ?? "",
    n.nome_emitente ?? "",
    n.cnpj_emitente ?? "",
    n.nome_destinatario ?? "",
    n.cnpj_destinatario ?? "",
    // pt-BR: vírgula decimal pro Excel ler como número.
    n.valor_total != null ? String(n.valor_total).replace(".", ",") : "",
    n.data_emissao ?? "",
    csvTs(n.arrived_at),
    csvTs(n.synced_at),
    csvTs(n.imported_at),
    n.via_robo === true ? "Sim" : "",
    n.motivo_ignorado ?? "",
  ];
}

const EMPRESA_CSV_HEADERS = [
  "Empresa", "Cód. empresa", "Cód. filial", "Pendentes", "A sincronizar",
  "Sincronizadas", "Aguardando importação", "Importadas", "Ignoradas", "Em trânsito",
];

function empresaToCsvRow(e: EmpresaAgg): (string | number | null)[] {
  return [
    e.codigo_empresa == null ? "Sem empresa" : (e.nome_empresa || `#${e.codigo_empresa}-${e.codigo_filial ?? 1}`),
    e.codigo_empresa ?? "",
    e.codigo_filial ?? "",
    e.arrived + e.synced + e.pending_import,
    e.arrived,
    e.synced,
    e.pending_import,
    e.imported,
    e.import_ignored,
    e.in_transit,
  ];
}

// ── Saúde da empresa ──────────────────────────────────────────────────────────
// Semáforo de triagem por empresa = % das notas rastreadas que ainda estão
// pendentes (chegou+sincronizado+aguardando ÷ total rastreado). Bandas
// ajustáveis: verde <10% · amarelo 10–30% · vermelho >30%. Reusa as cores do
// SLA. É um proxy de triagem (não considera idade — latência é global).
const HEALTH_WARN = 0.1;
const HEALTH_CRIT = 0.3;
// Filtro de saúde da aba Empresas. "none" (sem notas) só aparece com "all".
type HealthFilter = "all" | "ok" | "warn" | "crit";
const HEALTH_FILTERS: { value: HealthFilter; label: string }[] = [
  { value: "all", label: "Toda saúde" },
  { value: "ok", label: "Saudável (<10%)" },
  { value: "warn", label: "Atenção (10–30%)" },
  { value: "crit", label: "Crítica (>30%)" },
];
function empresaHealth(e: EmpresaAgg): { tone: SlaTone; pct: number | null } {
  const tracked = e.arrived + e.synced + e.pending_import + e.imported + e.import_ignored;
  if (tracked === 0) return { tone: "none", pct: null };
  const pct = (e.arrived + e.synced + e.pending_import) / tracked;
  const tone: SlaTone = pct < HEALTH_WARN ? "ok" : pct < HEALTH_CRIT ? "warn" : "crit";
  return { tone, pct };
}
function HealthDot({ e }: { e: EmpresaAgg }) {
  const h = empresaHealth(e);
  return (
    <span
      className={`inline-block h-2 w-2 shrink-0 rounded-full ${SLA_DOT[h.tone]}`}
      title={h.pct == null ? "Sem notas rastreadas" : `Saúde: ${(h.pct * 100).toFixed(0)}% das notas pendentes`}
      aria-hidden
    />
  );
}

// ── Consultas salvas (presets) ────────────────────────────────────────────────
// Salva o conjunto de filtros da aba Notas em localStorage pra reusar as
// consultas frequentes (ex.: "minhas empresas travadas"). Guarda só os filtros
// explícitos (status/tipo/busca/empresa/cnpj/data) — não a navegação por
// drill-down (codigo_empresa).
const NOTAS_PRESETS_KEY = "xml:notas:presets";
const EMPRESAS_PRESETS_KEY = "xml:empresas:presets";
type NotasPresetFilters = {
  statusFilter: NotaStatus | "all";
  docFilter: DocType | "all";
  direction: Direction | "all";
  q: string;
  numero: string;
  empresa: string;
  cnpj: string;
  dateField: DateField;
  from: string;
  to: string;
};
type EmpresasPresetFilters = {
  search: string;
  docFilter: DocType | "all";
  direction: Direction | "all";
  healthFilter: HealthFilter;
  dateField: DateField;
  from: string;
  to: string;
};

function loadSaved<T extends Record<string, string>>(key: string): (T & { name: string })[] {
  if (typeof window === "undefined") return [];
  try {
    const v = JSON.parse(localStorage.getItem(key) ?? "[]");
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

// Menu "Consultas salvas" genérico (Notas e Empresas). Guarda os filtros (todos
// strings) em localStorage sob `storageKey`; aplicar chama onApply.
function SavedQueriesMenu<T extends Record<string, string>>({
  storageKey,
  current,
  onApply,
}: {
  storageKey: string;
  current: T;
  onApply: (f: T) => void;
}) {
  const [open, setOpen] = useState(false);
  // Lazy init: lê o localStorage no 1º render do cliente (o menu começa fechado,
  // então não há conteúdo de preset no HTML estático → sem mismatch de hidratação).
  const [items, setItems] = useState<(T & { name: string })[]>(() => loadSaved<T>(storageKey));
  const [name, setName] = useState("");

  function persist(next: (T & { name: string })[]) {
    setItems(next);
    localStorage.setItem(storageKey, JSON.stringify(next));
  }
  function save() {
    const n = name.trim();
    if (!n) return;
    persist([...items.filter((p) => p.name !== n), { ...current, name: n } as T & { name: string }]);
    setName("");
    toast.success(`Consulta "${n}" salva.`);
  }

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="inline-flex items-center gap-1 rounded-full border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-900 px-2.5 py-1 text-xs text-gray-600 dark:text-gray-400 hover:border-rps-olive-dark hover:text-rps-olive-dark transition-colors"
      >
        Consultas salvas
        <ChevronDown className="h-3 w-3" aria-hidden />
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} aria-hidden />
          <div className="absolute right-0 z-20 mt-1 w-72 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 p-2 shadow-lg">
            {items.length === 0 ? (
              <p className="px-2 py-1.5 text-xs text-gray-400">Nenhuma consulta salva ainda.</p>
            ) : (
              <ul className="max-h-60 overflow-y-auto">
                {items.map((p) => (
                  <li key={p.name} className="flex items-center gap-1">
                    <button
                      type="button"
                      onClick={() => {
                        onApply(p);
                        setOpen(false);
                      }}
                      className="min-w-0 flex-1 truncate rounded px-2 py-1.5 text-left text-sm text-gray-700 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-800"
                    >
                      {p.name}
                    </button>
                    <button
                      type="button"
                      onClick={() => persist(items.filter((x) => x.name !== p.name))}
                      aria-label={`Excluir consulta ${p.name}`}
                      className="rounded p-1 text-gray-400 hover:text-red-600 dark:hover:text-red-400"
                    >
                      <X className="h-3.5 w-3.5" aria-hidden />
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <div className="mt-2 flex gap-1 border-t border-gray-100 pt-2 dark:border-gray-800">
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && save()}
                placeholder="Salvar consulta atual como…"
                className="min-w-0 flex-1 rounded border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-900 px-2 py-1 text-xs placeholder-gray-500 focus:border-rps-olive-dark focus:outline-none"
              />
              <button
                type="button"
                onClick={save}
                disabled={!name.trim()}
                className="rounded bg-rps-olive-dark px-2 py-1 text-xs font-medium text-white hover:bg-rps-olive-darker disabled:opacity-50 disabled:pointer-events-none"
              >
                Salvar
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

// ISO do evento mais recente da nota — o MÁXIMO entre chegada/sync/importação,
// não a ordem do pipeline. (Há notas em que o sync é registrado depois do
// import; "último evento" deve ser o cronologicamente mais recente.)
function lastEventIso(n: { arrived_at?: string; synced_at?: string; imported_at?: string }): string | undefined {
  const ts = [n.arrived_at, n.synced_at, n.imported_at].filter(Boolean) as string[];
  if (ts.length === 0) return undefined;
  return ts.reduce((a, b) => (new Date(b).getTime() > new Date(a).getTime() ? b : a));
}

// Texto formatado do último evento. "—" se a nota não tem nenhum timestamp.
function lastEventTs(n: { arrived_at?: string; synced_at?: string; imported_at?: string }): string {
  return fmtTs(lastEventIso(n));
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
  const [numero, setNumero] = useState(() => sp.get("numero") ?? "");
  const [direction, setDirection] = useState<Direction | "all">(
    () => (sp.get("direction") as Direction) || "all"
  );
  const [offset, setOffset] = useState(() => Number(sp.get("offset")) || 0);
  const [selected, setSelected] = useState<string | null>(null);
  const [glossaryOpen, setGlossaryOpen] = useState(false);
  // Modo Apresentação (TV). Abre via botão (com fullscreen) ou ?present=1
  // (slides) / ?present=mural (tela única).
  const presentParam = sp.get("present");
  const [presenting, setPresenting] = useState(() => presentParam === "1" || presentParam === "slides" || presentParam === "mural");
  const presentInitialMode: "slides" | "mural" = presentParam === "mural" ? "mural" : "slides";
  function startPresentation() {
    setPresenting(true);
    document.documentElement.requestFullscreen?.().catch(() => {});
  }
  function stopPresentation() {
    setPresenting(false);
    if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {});
  }
  // Período dos cards (item #5). today via lazy init (não usa relógio em render).
  const [today] = useState(() => new Date().toISOString().slice(0, 10));
  const [cardRange, setCardRange] = useState<CardRange>("all");
  const [cardDateField, setCardDateField] = useState<DateField>("arrived");
  type NotasSortKey = "chave" | "numero" | "tipo" | "emissao" | "cod" | "empresa" | "emitente" | "valor" | "status" | "evento";
  const [notasSort, setNotasSort] = useState<{ key: NotasSortKey; dir: "asc" | "desc" } | null>(null);
  const toggleNotasSort = (key: NotasSortKey) =>
    setNotasSort((s) =>
      s?.key === key ? (s.dir === "asc" ? null : { key, dir: "asc" }) : { key, dir: "desc" },
    );

  // Espelha os filtros na URL (sem navegar/refetch): URL compartilhável e
  // base pro drill-down por empresa do Bloco C1.
  useEffect(() => {
    const p = new URLSearchParams();
    if (view === "empresas" || view === "painel") p.set("view", view);
    if (statusFilter !== "all") p.set("status", statusFilter);
    if (docFilter !== "all") p.set("doc_type", docFilter);
    if (direction !== "all") p.set("direction", direction);
    if (q) p.set("q", q);
    if (numero) p.set("numero", numero);
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
  }, [view, statusFilter, docFilter, direction, q, numero, empresa, cnpj, semEmpresa, codigoEmpresa, codigoFilial, dateField, from, to, offset]);

  // Janela do período selecionado (null = snapshot global). Determinística.
  const cardWindow =
    cardRange === "all" ? null
    : cardRange === "today" ? { from: today, to: today }
    : cardRange === "7d" ? { from: subDaysIso(today, 6), to: today }
    : { from: subDaysIso(today, 29), to: today };
  const flowMode = cardWindow != null;
  // Janela aplicada às queries de cards (overview + agregado de empresas).
  const cardWindowParams = cardWindow
    ? { date_field: cardDateField, from: cardWindow.from, to: cardWindow.to }
    : {};

  const overview = useQuery({
    queryKey: ["xml", "overview", cardRange, cardDateField],
    queryFn: () => xmlMetricsApi.overview(cardWindowParams).then((r) => r.data),
    refetchInterval: 10_000,
  });

  // Quando um filtro de empresa está ativo, busca os agregados de TODAS as
  // empresas (mesmo dataset da aba Empresas, compartilhado por cache) pra
  // derivar os números daquela empresa e refletir nos cards + chips. A janela
  // do período é aplicada aqui também pra os cards por empresa baterem.
  const empresaFiltered = codigoEmpresa != null;
  const empresaAggQ = useQuery({
    queryKey: ["xml", "empresas", "all", cardRange, cardDateField],
    queryFn: () => empresasApi.list({ limit: 0, ...cardWindowParams }).then((r) => r.data),
    refetchInterval: 30_000,
    enabled: empresaFiltered,
  });

  // Filtros das notas sem paginação — compartilhados pela lista e pela
  // exportação CSV (que puxa o mesmo conjunto com um teto maior).
  const notaFilters: NotaListFilter = {
    status: statusFilter === "all" ? undefined : statusFilter,
    doc_type: docFilter === "all" ? undefined : docFilter,
    direction: direction === "all" ? undefined : direction,
    q: q || undefined,
    numero: numero || undefined,
    empresa: empresa || undefined,
    cnpj: cnpj || undefined,
    sem_empresa: semEmpresa || undefined,
    codigo_empresa: codigoEmpresa ?? undefined,
    codigo_filial: codigoFilial ?? undefined,
    date_field: from || to ? dateField : undefined,
    from: from || undefined,
    to: to || undefined,
  };

  const list = useQuery({
    queryKey: ["xml", "notas", { statusFilter, docFilter, direction, q, numero, empresa, cnpj, semEmpresa, codigoEmpresa, codigoFilial, dateField, from, to, offset }],
    queryFn: () =>
      notasApi.list({ ...notaFilters, limit: PAGE_SIZE, offset }).then((r) => r.data),
    refetchInterval: 15_000,
    placeholderData: (prev) => prev,
    enabled: view === "notas",
  });

  // Apuração do filtro atual (contagem + soma dos valores). SEM offset na chave:
  // muda com o filtro, não com a paginação (1 chamada por filtro, como pedido).
  const summary = useQuery({
    queryKey: ["xml", "notas-summary", { statusFilter, docFilter, direction, q, numero, empresa, cnpj, semEmpresa, codigoEmpresa, codigoFilial, dateField, from, to }],
    queryFn: () => notasApi.summary(notaFilters).then((r) => r.data),
    refetchInterval: 30_000,
    placeholderData: (prev) => prev,
    enabled: view === "notas",
  });

  const [exporting, setExporting] = useState(false);
  async function exportNotasCsv() {
    if (exporting) return;
    setExporting(true);
    try {
      const { data } = await notasApi.list({ ...notaFilters, limit: EXPORT_CAP, offset: 0 });
      if (data.items.length === 0) {
        toast.info("Nenhuma nota pra exportar com os filtros atuais.");
        return;
      }
      downloadCsv(`notas-xml-${fileStamp()}`, toCsv(NOTA_CSV_HEADERS, data.items.map(notaToCsvRow)));
      if (data.total > data.items.length) {
        toast.warning(`Exportadas ${data.items.length} de ${data.total} notas (teto de ${EXPORT_CAP.toLocaleString("pt-BR")}). Refine os filtros pra exportar o restante.`);
      } else {
        toast.success(`${data.items.length.toLocaleString("pt-BR")} nota(s) exportada(s).`);
      }
    } catch {
      toast.error("Falha ao exportar as notas.");
    } finally {
      setExporting(false);
    }
  }

  const ovGlobal = overview.data;
  // Agregado da empresa filtrada: soma as linhas (empresa, filial) que casam.
  // Vira a fonte de cards/chips quando há filtro de empresa; latências ficam
  // sempre globais (não há percentil por empresa no agregado).
  const empOv: Overview | undefined = (() => {
    if (!empresaFiltered || !empresaAggQ.data) return undefined;
    const rows = empresaAggQ.data.items.filter(
      (e) =>
        e.codigo_empresa === codigoEmpresa &&
        (codigoFilial == null || e.codigo_filial === codigoFilial),
    );
    if (rows.length === 0) return undefined;
    const sum = (k: keyof EmpresaAgg) => rows.reduce((a, e) => a + ((e[k] as number) ?? 0), 0);
    return {
      arrived: sum("arrived"),
      synced: sum("synced"),
      pending_import: sum("pending_import"),
      imported: sum("imported"),
      import_ignored: sum("import_ignored"),
      in_transit: sum("in_transit"),
      imported_today: 0, // não existe por empresa
      lat_arrival_sync_p50_s: ovGlobal?.lat_arrival_sync_p50_s,
      lat_arrival_sync_p95_s: ovGlobal?.lat_arrival_sync_p95_s,
      lat_sync_import_p50_s: ovGlobal?.lat_sync_import_p50_s,
      lat_sync_import_p95_s: ovGlobal?.lat_sync_import_p95_s,
    };
  })();
  // Fonte exibida nos cards/chips: empresa quando filtrada, senão global.
  const ov = empOv ?? ovGlobal;
  const total = list.data?.total ?? 0;
  const rawItems = list.data?.items ?? [];
  // Status ordering for sort: pipeline stage order.
  const STATUS_ORDER: Record<NotaStatus, number> = {
    arrived: 0, synced: 1, pending_import: 2, imported: 3, import_ignored: 4,
  };
  const items = notasSort
    ? [...rawItems].sort((a, b) => {
        const dir = notasSort.dir === "asc" ? 1 : -1;
        switch (notasSort.key) {
          case "chave":   return dir * a.chave_acesso.localeCompare(b.chave_acesso);
          case "numero":  return dir * (a.numero_nota ?? "").localeCompare(b.numero_nota ?? "");
          case "tipo":    return dir * a.doc_type.localeCompare(b.doc_type);
          case "emissao": return dir * ((a.data_emissao ?? "").localeCompare(b.data_emissao ?? ""));
          case "cod":     return dir * ((a.codigo_empresa ?? 0) - (b.codigo_empresa ?? 0));
          case "empresa": return dir * (a.nome_empresa ?? "").localeCompare(b.nome_empresa ?? "");
          case "emitente":return dir * (a.nome_emitente ?? "").localeCompare(b.nome_emitente ?? "");
          case "valor":   return dir * ((a.valor_total ?? 0) - (b.valor_total ?? 0));
          case "status":  return dir * ((STATUS_ORDER[a.status] ?? 9) - (STATUS_ORDER[b.status] ?? 9));
          case "evento":  return dir * ((lastEventIso(a) ?? "").localeCompare(lastEventIso(b) ?? ""));
          default:        return 0;
        }
      })
    : rawItems;
  const page = Math.floor(offset / PAGE_SIZE) + 1;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  // "Pendente" = notas ainda no pipeline (chegou + sincronizado + aguardando
  // importação). Terminais (importada/ignorada) ficam fora. Mantém cards e filtro
  // alinhados.
  const pendentes = ov ? ov.arrived + ov.synced + ov.pending_import : 0;
  // Loading dos cards: empresa quando filtrada (espera o agregado), senão global.
  const cardsLoading = empresaFiltered ? empresaAggQ.isLoading && !empOv : overview.isLoading;

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

  // Há algum filtro ativo além dos defaults?
  const hasFilters =
    statusFilter !== "all" ||
    docFilter !== "all" ||
    direction !== "all" ||
    q !== "" ||
    numero !== "" ||
    empresa !== "" ||
    cnpj !== "" ||
    from !== "" ||
    to !== "" ||
    codigoEmpresa != null ||
    codigoFilial != null ||
    semEmpresa;

  function clearAllFilters() {
    setStatusFilter("all");
    setDocFilter("all");
    setDirection("all");
    setQ("");
    setNumero("");
    setEmpresa("");
    setCnpj("");
    setFrom("");
    setTo("");
    setCodigoEmpresa(null);
    setCodigoFilial(null);
    setSemEmpresa(false);
    setOffset(0);
  }

  // Snapshot dos filtros explícitos pra salvar como consulta (preset).
  const currentPreset: NotasPresetFilters = { statusFilter, docFilter, direction, q, numero, empresa, cnpj, dateField, from, to };
  // Aplica uma consulta salva: seta os filtros e zera a navegação por drill.
  function applyPreset(p: NotasPresetFilters) {
    setStatusFilter(p.statusFilter);
    setDocFilter(p.docFilter);
    setDirection(p.direction ?? "all");
    setQ(p.q);
    setNumero(p.numero ?? "");
    setEmpresa(p.empresa);
    setCnpj(p.cnpj);
    setDateField(p.dateField);
    setFrom(p.from);
    setTo(p.to);
    clearEmpresaFilter();
  }

  // Drill-down da visão por empresa → abre a aba Notas filtrada por aquela
  // (empresa, filial), ou pelo bucket "sem empresa". `filters` carrega os
  // filtros que estavam ativos na aba Empresas (data/janela) pra manter a
  // consistência ao trocar de aba; sem `filters` (ex.: drill do Painel) a
  // janela de data atual da aba Notas é preservada.
  function drillToEmpresa(row: EmpresaAgg, filters?: DrillFilters) {
    setStatusFilter("all");
    setOffset(0);
    if (filters) {
      setDateField(filters.dateField);
      setFrom(filters.from);
      setTo(filters.to);
      setDocFilter(filters.docFilter);
      setDirection(filters.direction);
    }
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
      {/* Frescor dos dados + acesso ao status dos serviços do tracker + modo TV */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Link
            href="/xml/status"
            className="inline-flex items-center gap-1.5 rounded-md border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 px-2.5 py-1 text-xs text-gray-600 dark:text-gray-400 hover:border-rps-olive-dark hover:text-rps-olive-dark transition-colors shadow-sm"
          >
            <RadioTower className="h-3.5 w-3.5" aria-hidden />
            Status do tracker
          </Link>
          <button
            type="button"
            onClick={startPresentation}
            title="Modo Apresentação em tela cheia (ideal pra TV)"
            className="inline-flex items-center gap-1.5 rounded-md border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 px-2.5 py-1 text-xs text-gray-600 dark:text-gray-400 hover:border-rps-olive-dark hover:text-rps-olive-dark transition-colors shadow-sm"
          >
            <Monitor className="h-3.5 w-3.5" aria-hidden />
            Apresentação
          </button>
        </div>
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

      {/* Cabeçalho de período (item #5). "Tudo" = foto do estado atual (estoque);
          os demais aplicam uma janela (modo flow: contagens do recorte por um
          campo de data). Resolve "de quando são esses números?". */}
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
        <h2 className="flex items-center gap-2 text-sm font-semibold text-gray-700 dark:text-gray-300">
          {flowMode ? "Fluxo no período" : "Estado atual do pipeline"}
          {empresaFilterLabel && <span className="font-normal text-gray-400"> · {empresaFilterLabel}</span>}
          <button
            type="button"
            onClick={() => setGlossaryOpen((o) => !o)}
            aria-expanded={glossaryOpen}
            className="inline-flex items-center gap-1 rounded text-xs font-normal text-gray-400 hover:text-rps-olive-dark transition-colors"
          >
            <Info className="h-3.5 w-3.5" aria-hidden />
            Entenda os estados
          </button>
        </h2>
        <div className="flex items-center gap-2">
          {flowMode && (
            <select
              value={cardDateField}
              onChange={(e) => setCardDateField(e.target.value as DateField)}
              title="Qual data define o recorte do período"
              className="rounded border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-900 px-2 py-1 text-xs text-gray-600 dark:text-gray-400 focus:border-rps-olive-dark focus:outline-none"
            >
              {(["emissao", "arrived", "synced", "imported"] as DateField[]).map((f) => (
                <option key={f} value={f}>por {DATE_FIELD_LABEL[f]}</option>
              ))}
            </select>
          )}
          <div className="inline-flex rounded-md border border-gray-200 dark:border-gray-700 bg-gray-100 dark:bg-gray-800 p-0.5">
            {CARD_RANGES.map((r) => (
              <button
                key={r.value}
                type="button"
                onClick={() => setCardRange(r.value)}
                className={`rounded px-2.5 py-0.5 text-xs font-medium transition-colors ${
                  cardRange === r.value
                    ? "bg-white dark:bg-gray-900 text-rps-olive-dark shadow-sm"
                    : "text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-200"
                }`}
              >
                {r.label}
              </button>
            ))}
          </div>
        </div>
      </div>
      <p className="text-xs text-gray-400">
        {flowMode
          ? `Recorte por ${DATE_FIELD_LABEL[cardDateField]} no período — contagem das notas pelo status atual, restrita ao recorte (não é o estoque). "Importadas hoje" e latências seguem globais.`
          : "Foto de agora: todas as notas paradas em cada etapa, independente de quando entraram."}
      </p>
      {glossaryOpen && <StatusGlossary />}
      {/* Cards do pipeline. Quando há filtro de empresa, refletem os números
          daquela empresa. */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-5">
        <StatCard label="A Sincronizar" value={ov?.arrived ?? "—"} tone={ov?.arrived ? "warning" : "neutral"} loading={cardsLoading} title="Notas que chegaram mas ainda não sincronizaram — contagem de agora." />
        <StatCard label="Sincronizadas" value={ov?.synced ?? "—"} loading={cardsLoading} title="Notas sincronizadas aguardando o próximo passo — contagem de agora." />
        <StatCard label="Aguardando Importação" value={ov?.pending_import ?? "—"} loading={cardsLoading} title="Vistas no Athenas, ainda não importadas — contagem de agora." />
        {empresaFiltered ? (
          <StatCard label="Importadas" value={ov?.imported ?? "—"} hint="acumulado" tone="success" loading={cardsLoading} title="Total importado desta empresa desde sempre (acumulado, não é o estado atual)." />
        ) : (
          <StatCard label="Importadas hoje" value={ov?.imported_today ?? "—"} hint="somente hoje" tone="success" loading={cardsLoading} title="Fluxo do dia: notas importadas hoje. É a única contagem por período — o filtro 'Importada' mostra todas." />
        )}
        <StatCard label="Ignoradas" value={ov?.import_ignored ?? "—"} loading={cardsLoading} title="Notas marcadas como ignoradas — contagem de agora." />
      </div>
      {/* Saúde/qualidade do processamento numa linha só: backlog + acurácia do
          import + as duas esperas (censuradas). Acurácia é independente do
          overview (vem do /status), por isso a linha não é gated em `ov`. */}
      <div className="space-y-1">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <div className="rounded-lg border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 p-3 shadow-sm">
            <p className="text-xs font-medium uppercase tracking-wider text-gray-500">Backlog pendente</p>
            <div className="mt-1 flex items-baseline gap-2">
              <span className="text-2xl font-bold text-gray-900 dark:text-gray-100" title={ov ? fmtFull(pendentes) : undefined}>
                {ov ? fmtCompact(pendentes) : "—"}
              </span>
              <span className="text-xs text-gray-400">notas no pipeline</span>
            </div>
            <p className="mt-0.5 text-xs text-gray-500">
              {ov ? (
                <>
                  <span title={fmtFull(ov.in_transit)}>{fmtCompact(ov.in_transit)}</span> em trânsito
                </>
              ) : (
                "—"
              )}
            </p>
          </div>
          <AccuracyCard />
          {/* Latência do pipeline via endpoint novo /metrics/latency (os lat_*
              do overview foram removidos). Rende 2 tiles: fila de sync + import
              pós-sync. */}
          <LatencyCards />
        </div>
        <p className="text-xs text-gray-400">
          Pendentes = chegou + sincronizado + aguardando importação. Fila de sincronização =
          espera do programa que move Xml_ASincronizar → SINCRONIZADO (últimos 7d). SLA do p50:{" "}
          <b className="font-medium text-green-700 dark:text-green-400">&lt;24h</b> ·{" "}
          <b className="font-medium text-amber-700 dark:text-amber-400">24–72h</b> ·{" "}
          <b className="font-medium text-red-700 dark:text-red-400">&gt;72h</b>.
        </p>
      </div>

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
                // Mantém o filtro de empresa ao trocar de status: os chips e
                // cards já refletem a empresa filtrada (statusChipCount usa
                // empOv), então empresa + status combinam de forma coerente.
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
        <select
          value={direction}
          onChange={(e) => reset(setDirection)(e.target.value as Direction | "all")}
          title="Direção da nota relativa à empresa (entrada = recebida; saída = emitida)"
          className="rounded border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-900 px-2 py-1 text-sm focus:border-rps-olive-dark focus:outline-none"
        >
          <option value="all">Entrada e saída</option>
          <option value="entrada">Entrada</option>
          <option value="saida">Saída</option>
        </select>
        <input
          value={numero}
          onChange={(e) => reset(setNumero)(e.target.value.replace(/\D/g, ""))}
          inputMode="numeric"
          placeholder="Nº da nota…"
          title="Busca por prefixo do número da nota (nNF)"
          className="w-28 rounded border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-900 px-3 py-1.5 text-sm placeholder-gray-500 focus:border-rps-olive-dark focus:outline-none"
        />
        <input
          value={q}
          onChange={(e) => reset(setQ)(e.target.value.trim())}
          placeholder="Buscar por chave de acesso…"
          className="min-w-[220px] flex-1 rounded border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-900 px-3 py-1.5 text-sm placeholder-gray-500 focus:border-rps-olive-dark focus:outline-none"
        />
        <div className="flex items-center gap-3 ml-auto">
          {/* Apuração do filtro atual: contagem + soma dos valores (/notas/summary).
              "Atualizando…" só quando a MUDANÇA é do usuário (isPlaceholderData);
              o auto-refresh de fundo é silencioso. */}
          <span className="text-sm text-gray-500">
            {list.isPlaceholderData ? (
              "Atualizando…"
            ) : (
              <span title={fmtFull(total)}>
                {fmtCompact(total)} nota{total === 1 ? "" : "s"}
                {summary.data && (
                  <>
                    {" · "}
                    <b className="text-gray-700 dark:text-gray-300" title={summary.data.valor_total.toLocaleString("pt-BR", { style: "currency", currency: "BRL" })}>
                      Total: {fmtBRL(summary.data.valor_total)}
                    </b>
                  </>
                )}
              </span>
            )}
          </span>
          <SavedQueriesMenu storageKey={NOTAS_PRESETS_KEY} current={currentPreset} onApply={applyPreset} />
          <button
            type="button"
            onClick={exportNotasCsv}
            disabled={exporting || total === 0}
            title="Exportar as notas filtradas para CSV (abre no Excel)"
            className="inline-flex items-center gap-1 rounded-full border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-900 px-2.5 py-1 text-xs text-gray-600 dark:text-gray-400 hover:border-rps-olive-dark hover:text-rps-olive-dark transition-colors disabled:opacity-50 disabled:pointer-events-none"
          >
            <Download className="h-3 w-3" aria-hidden />
            {exporting ? "Exportando…" : "Exportar CSV"}
          </button>
          {hasFilters && (
            <button
              type="button"
              onClick={clearAllFilters}
              className="inline-flex items-center gap-1 rounded-full border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-900 px-2.5 py-1 text-xs text-gray-600 dark:text-gray-400 hover:border-red-400 hover:text-red-600 dark:hover:text-red-400 transition-colors"
            >
              <X className="h-3 w-3" aria-hidden />
              Limpar filtros
            </button>
          )}
        </div>
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

      {/* Tabela — envolta em relative para o overlay de loading */}
      <div className="relative">
        <TableLoadingOverlay isFetching={list.isPlaceholderData} />
      <Table stickyHeader>
        <THead sticky>
          {(
            [
              { key: "chave",    label: "Chave" },
              { key: "numero",   label: "Número" },
              { key: "tipo",     label: "Tipo" },
              { key: "emissao",  label: "Emissão", title: "Data de emissão da nota" },
              { key: "cod",      label: "Cód.", title: "Código da empresa" },
              { key: "empresa",  label: "Empresa" },
              { key: "emitente", label: "Emitente" },
              { key: "valor",    label: "Valor", title: "Valor total da nota" },
              { key: "status",   label: "Status" },
              { key: "evento",   label: "Último evento", title: "Data do evento mais recente (chegada, sincronização ou importação)" },
            ] as { key: NotasSortKey; label: string; title?: string }[]
          ).map(({ key, label, title }) => (
            <Th key={key} title={title}>
              <button
                type="button"
                onClick={() => toggleNotasSort(key)}
                className={`inline-flex items-center gap-1 uppercase tracking-wider ${notasSort?.key === key ? "text-gray-700 dark:text-gray-200" : "hover:text-gray-700 dark:hover:text-gray-300"}`}
              >
                {label}
                <SortIcon active={notasSort?.key === key} dir={notasSort?.dir} />
              </button>
            </Th>
          ))}
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
              <Td className="whitespace-nowrap text-gray-600 dark:text-gray-400">{fmtDateOnly(n.data_emissao)}</Td>
              <Td className="text-xs text-gray-500">
                {n.codigo_empresa != null ? (
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      setSemEmpresa(false);
                      setCodigoFilial(null);
                      reset(setCodigoEmpresa)(n.codigo_empresa!);
                    }}
                    className="hover:text-rps-olive-dark hover:underline"
                    title={n.nome_empresa || "Filtrar por esta empresa"}
                  >
                    #{n.codigo_empresa}
                  </button>
                ) : (
                  "—"
                )}
              </Td>
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
              <Td className="whitespace-nowrap text-right tabular-nums text-gray-700 dark:text-gray-300">
                {n.valor_total != null ? fmtBRL(n.valor_total) : "—"}
              </Td>
              <Td>
                <span className="inline-flex flex-wrap items-center gap-1">
                  <Badge className={XML_STATUS_STYLE[n.status]}>{XML_STATUS_LABEL[n.status]}</Badge>
                  <DirectionBadge direction={n.direction} />
                  <ViaRoboBadge via_robo={n.via_robo} />
                </span>
              </Td>
              <Td className="text-xs text-gray-500">{lastEventTs(n)}</Td>
            </Tr>
          ))}
          {list.isError && items.length === 0 && (
            <ErrorRow colSpan={10} onRetry={() => list.refetch()} />
          )}
          {!list.isLoading && !list.isError && items.length === 0 && (
            <EmptyRow colSpan={10}>Nenhuma nota encontrada com os filtros atuais.</EmptyRow>
          )}
          {list.isLoading && Array.from({ length: 6 }).map((_, i) => <SkeletonRow key={i} cols={10} />)}
        </TBody>
      </Table>
      </div>{/* /relative */}

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
      {presenting && <PresentationMode initialMode={presentInitialMode} onClose={stopPresentation} />}
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
];

// Cor sólida da barra por status (o badge usa XML_STATUS_STYLE; aqui é só o
// preenchimento da barra de proporção).
const STATUS_BAR_FILL: Record<NotaStatus, string> = {
  arrived: "bg-yellow-400",
  synced: "bg-sky-400",
  pending_import: "bg-amber-400",
  imported: "bg-rps-olive-dark",
  import_ignored: "bg-gray-400 dark:bg-gray-600",
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
// Cor da barra por faixa de idade do aging — quanto mais velho, mais quente.
const AGE_BUCKET_FILL: Record<string, string> = {
  "<1d": "bg-green-500",
  "1-3d": "bg-lime-500",
  "3-7d": "bg-amber-400",
  "7-30d": "bg-orange-500",
  ">30d": "bg-red-500",
};

// Lista de barras de uma dimensão do aging (to_sync ou to_import).
function AgingBars({ title, buckets }: { title: string; buckets: AgingBucket[] }) {
  const max = Math.max(1, ...buckets.map((b) => b.count));
  const total = buckets.reduce((a, b) => a + b.count, 0);
  return (
    <div>
      <p className="mb-2 text-xs font-medium text-gray-600 dark:text-gray-400">
        {title} · <span title={fmtFull(total)} className="cursor-help">{fmtCompact(total)}</span>
      </p>
      <ul className="space-y-1.5">
        {buckets.map((b) => (
          <li key={b.label} className="flex items-center gap-3">
            <span className="w-12 shrink-0 text-xs tabular-nums text-gray-500">{b.label}</span>
            <div className="h-2 flex-1 overflow-hidden rounded-full bg-gray-100 dark:bg-gray-800">
              <div
                className={`h-full rounded-full ${AGE_BUCKET_FILL[b.label] ?? "bg-gray-400"}`}
                style={{ width: `${(b.count / max) * 100}%` }}
              />
            </div>
            <span title={fmtFull(b.count)} className="w-14 shrink-0 cursor-help text-right text-sm font-medium tabular-nums text-gray-700 dark:text-gray-300">
              {fmtCompact(b.count)}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

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
  const aging = useQuery({
    queryKey: ["xml", "aging", "painel"],
    queryFn: () => xmlMetricsApi.aging().then((r) => r.data),
    refetchInterval: 60_000,
  });
  // Latência do pipeline (endpoint novo). Mesma chave da manchete → cache compartilhado.
  const latency = useQuery({
    queryKey: ["xml", "latency", 7],
    queryFn: () => xmlMetricsApi.latency(7).then((r) => r.data),
    refetchInterval: 60_000,
  });

  // "imported" fica FORA das barras: é ordens de grandeza maior (milhões de
  // notas terminais) e achataria as demais. Plotamos o resto e mostramos o
  // total de importadas à parte.
  const barStatuses = PAINEL_STATUSES.filter((s) => s !== "imported");
  const counts = ov ? barStatuses.map((s) => ({ status: s, count: statusCount(ov, s) })) : [];
  const maxCount = Math.max(1, ...counts.map((c) => c.count));
  const importedTotal = ov ? ov.imported : 0;
  const grandTotal = ov ? PAINEL_STATUSES.reduce((a, s) => a + statusCount(ov, s), 0) : 0;

  const pend = (e: EmpresaAgg) => e.arrived + e.synced + e.pending_import;
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

      <PainelCard title="Latência do pipeline (7d)">
        {latency.isError ? (
          <ErrorState onRetry={() => latency.refetch()} />
        ) : latency.isLoading ? (
          <Skeleton className="h-40 w-full" />
        ) : (
          <div className="space-y-4">
            <LatencyRow
              label="Fila de sincronização (chegada → sync)"
              p50={latency.data?.arrival_to_sync.p50_s ?? undefined}
              p95={latency.data?.arrival_to_sync.p95_s ?? undefined}
            />
            <div>
              <p className="mb-1 text-xs font-medium text-gray-600 dark:text-gray-400">Importação pós-sync</p>
              {latency.data && latency.data.sync_to_import.count > 0 ? (
                <p className="text-sm text-gray-500">
                  <b className="text-gray-800 dark:text-gray-200">{fmtPct1(latency.data.sync_to_import.same_day_pct)}%</b> no mesmo dia
                  {" · "}D+1: {fmtFull(latency.data.sync_to_import.d1)} · D+2+: {fmtFull(latency.data.sync_to_import.d2_plus)} de {fmtFull(latency.data.sync_to_import.count)}
                </p>
              ) : (
                <p className="text-sm text-gray-400">sem dados na janela</p>
              )}
            </div>
            <div className="grid grid-cols-2 gap-3 pt-1">
              <MiniStat label="Em trânsito" value={ov?.in_transit ?? 0} />
              <MiniStat label="Importadas hoje" value={ov?.imported_today ?? 0} tone="success" />
            </div>
            <p className="text-xs text-gray-400">
              Fila de sincronização = espera do programa que move os XML (últimos 7 dias).
              Distribuição por idade do backlog no card &quot;Idade do backlog&quot;.
            </p>
          </div>
        )}
      </PainelCard>

      <PainelCard title="Idade do backlog (aging)" className="lg:col-span-2">
        {aging.isError ? (
          <ErrorState onRetry={() => aging.refetch()} />
        ) : aging.isLoading ? (
          <Skeleton className="h-40 w-full" />
        ) : !aging.data || (aging.data.to_sync.length === 0 && aging.data.to_import.length === 0) ? (
          <EmptyState className="py-4">Sem backlog pendente. 🎉</EmptyState>
        ) : (
          <>
            <div className="grid gap-6 sm:grid-cols-2">
              <AgingBars title="Aguardando sincronização" buckets={aging.data.to_sync} />
              <AgingBars title="Aguardando importação" buckets={aging.data.to_import} />
            </div>
            <p className="mt-3 text-xs text-gray-400">
              Há quanto tempo as notas pendentes estão paradas (sincronização contada da
              chegada; importação contada da sincronização). Quanto mais quente a barra,
              mais velho o backlog.
            </p>
          </>
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

// Ícone de ordenação reutilizado nas duas tabelas.
function SortIcon({ active, dir }: { active: boolean; dir?: "asc" | "desc" }) {
  if (!active) return null;
  return dir === "asc"
    ? <ChevronUp className="h-3 w-3" aria-hidden />
    : <ChevronDown className="h-3 w-3" aria-hidden />;
}

type EmpSortKey = "empresa" | "saude" | "pendentes" | "arrived" | "synced" | "pending_import" | "imported";

// Colunas numéricas da tabela de Empresas, com rótulo curto + tooltip (o
// cabeçalho é abreviado por espaço) + tom de cor. Ordem = ordem na tabela.
const EMP_COLS: { key: EmpSortKey; label: string; title: string; tone?: "danger" | "warn" }[] = [
  { key: "saude", label: "Saúde", title: "% das notas rastreadas que estão pendentes" },
  { key: "pendentes", label: "Pendentes", title: "Chegou + sincronizado + aguardando importação" },
  { key: "arrived", label: "A sinc.", title: "A sincronizar", tone: "warn" },
  { key: "synced", label: "Sincr.", title: "Sincronizadas" },
  { key: "pending_import", label: "Aguard.", title: "Aguardando importação" },
  { key: "imported", label: "Importadas", title: "Importadas (acumulado histórico)" },
];

function empValue(e: EmpresaAgg, key: EmpSortKey): number | string {
  if (key === "empresa") return e.nome_empresa ?? "";
  if (key === "pendentes") return e.arrived + e.synced + e.pending_import;
  // "sem notas" (pct null) ordena como o menor valor.
  if (key === "saude") return empresaHealth(e).pct ?? -1;
  return e[key];
}

// Visão por empresa: uma linha por (empresa, filial) + a linha "Sem empresa"
// (sempre fixada por último). Ordenável por qualquer coluna numérica (default
// pendentes desc). Drill-down reusa os filtros de URL da aba Notas.
function EmpresasView({ onDrill }: { onDrill: (row: EmpresaAgg, filters: DrillFilters) => void }) {
  const [search, setSearch] = useState("");
  // 150ms: mais responsivo que 300ms; o backend /empresas com ?q= é leve pois
  // retorna apenas matches parciais por nome (não todas as empresas).
  const debounced = useDebounced(search.trim(), 150);
  // Filtro de data — recomputa os agregados por janela no backend (mesma
  // semântica do /notas). Com janela, o /empresas conta ao vivo da tabela notas.
  const [dateField, setDateField] = useState<DateField>("imported");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  // Tipo de documento e direção — forçam o recompute ao vivo no tracker.
  const [docFilter, setDocFilter] = useState<DocType | "all">("all");
  const [direction, setDirection] = useState<Direction | "all">("all");
  // Filtro de saúde (client-side, sobre o agregado da empresa).
  const [healthFilter, setHealthFilter] = useState<HealthFilter>("all");
  const q = useQuery({
    // Busca por nome via API (?q=, parcial/case-insensitive) + filtros (data,
    // tipo, direção). Mantém limit:0 (todas as linhas) + sort/paginação client.
    queryKey: ["xml", "empresas", debounced, dateField, from, to, docFilter, direction],
    queryFn: () =>
      empresasApi
        .list({
          limit: 0,
          q: debounced || undefined,
          date_field: from || to ? dateField : undefined,
          from: from || undefined,
          to: to || undefined,
          doc_type: docFilter === "all" ? undefined : docFilter,
          direction: direction === "all" ? undefined : direction,
        })
        .then((r) => r.data),
    refetchInterval: 30_000,
    placeholderData: (prev) => prev,
  });

  // Consulta salva (preset) da aba Empresas.
  const currentEmpresaPreset: EmpresasPresetFilters = { search, docFilter, direction, healthFilter, dateField, from, to };
  function applyEmpresaPreset(p: EmpresasPresetFilters) {
    setSearch(p.search ?? "");
    setDocFilter(p.docFilter ?? "all");
    setDirection(p.direction ?? "all");
    setHealthFilter(p.healthFilter ?? "all");
    setDateField(p.dateField ?? "imported");
    setFrom(p.from ?? "");
    setTo(p.to ?? "");
  }

  const [sort, setSort] = useState<{ key: EmpSortKey; dir: "asc" | "desc" }>({
    key: "pendentes",
    dir: "desc",
  });
  const toggleSort = (key: EmpSortKey) =>
    setSort((s) => (s.key === key ? { key, dir: s.dir === "desc" ? "asc" : "desc" } : { key, dir: "desc" }));

  const pend = (e: EmpresaAgg) => e.arrived + e.synced + e.pending_import;

  // Quais empresas (codigo_empresa) estão expandidas mostrando as filiais.
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const toggleExpand = (cod: number) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(cod)) next.delete(cod); else next.add(cod);
      return next;
    });

  // Comparador conforme a coluna/direção ativa (string = nome, senão número).
  const cmp = (a: EmpresaAgg, b: EmpresaAgg) => {
    const av = empValue(a, sort.key);
    const bv = empValue(b, sort.key);
    return typeof av === "string" && typeof bv === "string"
      ? sort.dir === "desc" ? bv.localeCompare(av) : av.localeCompare(bv)
      : sort.dir === "desc" ? (bv as number) - (av as number) : (av as number) - (bv as number);
  };

  // Agrupa por empresa: uma linha-mãe com a soma das filiais (expansível). A
  // linha "Sem empresa" e empresas de filial única não expandem. Ordena as
  // filiais dentro do grupo e os grupos entre si pela mesma coluna.
  type EmpGroup = {
    key: string;
    codigo_empresa: number | null;
    nome: string;
    filiais: EmpresaAgg[];
    total: EmpresaAgg;
    isNoEmpresa: boolean;
  };
  const items = q.data?.items ?? [];
  const byEmpresa = new Map<number, EmpresaAgg[]>();
  let semEmpresaRow: EmpresaAgg | undefined;
  for (const e of items) {
    if (e.codigo_empresa == null) { semEmpresaRow = e; continue; }
    const arr = byEmpresa.get(e.codigo_empresa) ?? [];
    arr.push(e);
    byEmpresa.set(e.codigo_empresa, arr);
  }
  const sumAgg = (arr: EmpresaAgg[], cod: number, nome: string): EmpresaAgg => {
    const s = (k: keyof EmpresaAgg) => arr.reduce((a, e) => a + ((e[k] as number) ?? 0), 0);
    return {
      codigo_empresa: cod, codigo_filial: undefined, nome_empresa: nome,
      arrived: s("arrived"), synced: s("synced"), pending_import: s("pending_import"),
      imported: s("imported"), import_ignored: s("import_ignored"), in_transit: s("in_transit"),
    };
  };
  const groups: EmpGroup[] = [...byEmpresa.entries()]
    .map(([cod, arr]) => {
      const nome = arr.find((e) => e.nome_empresa)?.nome_empresa || `#${cod}`;
      return {
        key: String(cod), codigo_empresa: cod, nome,
        filiais: [...arr].sort(cmp), total: sumAgg(arr, cod, nome), isNoEmpresa: false,
      };
    })
    .sort((a, b) => cmp(a.total, b.total));
  if (semEmpresaRow) {
    groups.push({
      key: "sem-empresa", codigo_empresa: null, nome: "Sem empresa",
      filiais: [semEmpresaRow], total: semEmpresaRow, isNoEmpresa: true,
    });
  }
  // Filtro de saúde: mantém só os grupos cujo agregado casa com a banda.
  const shownGroups = healthFilter === "all" ? groups : groups.filter((g) => empresaHealth(g.total).tone === healthFilter);
  const empresaCount = shownGroups.filter((g) => !g.isNoEmpresa).length;
  // Linhas planas (nível filial) pra exportação — granularidade mais útil.
  const flatRows = [...items]
    .filter((e) => healthFilter === "all" || empresaHealth(e).tone === healthFilter)
    .sort((a, b) => {
      const aNo = a.codigo_empresa == null, bNo = b.codigo_empresa == null;
      if (aNo !== bNo) return aNo ? 1 : -1;
      return cmp(a, b);
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

  // Células numéricas de uma linha (mãe ou filial) — mesmas colunas/estilo.
  const numCells = (e: EmpresaAgg) =>
    EMP_COLS.map((col) => {
      if (col.key === "saude") {
        const h = empresaHealth(e);
        return (
          <Td key={col.key} className="text-right">
            <span className="inline-flex items-center justify-end gap-1.5">
              <HealthDot e={e} />
              <span className="tabular-nums text-gray-700 dark:text-gray-300">{h.pct == null ? "—" : `${(h.pct * 100).toFixed(0)}%`}</span>
            </span>
          </Td>
        );
      }
      if (col.key === "pendentes") {
        return (
          <Td key={col.key} className="text-right font-semibold text-gray-900 dark:text-gray-100">
            <span title={fmtFull(pend(e))} className="cursor-help">{fmtCompact(pend(e))}</span>
          </Td>
        );
      }
      if (col.key === "imported") {
        return (
          <Td key={col.key} className="text-right text-gray-500">
            <span title={fmtFull(e.imported)} className="cursor-help">{fmtCompact(e.imported)}</span>
          </Td>
        );
      }
      return (
        <Td key={col.key} className="text-right">
          {cell(empValue(e, col.key) as number, col.tone)}
        </Td>
      );
    });

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Buscar empresa por nome…"
          className="w-72 rounded border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-900 px-3 py-1.5 text-sm placeholder-gray-500 focus:border-rps-olive-dark focus:outline-none"
        />
        <select
          value={docFilter}
          onChange={(e) => setDocFilter(e.target.value as DocType | "all")}
          className="rounded border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-900 px-2 py-1 text-sm focus:border-rps-olive-dark focus:outline-none"
        >
          {DOC_TYPES.map((d) => (
            <option key={d} value={d}>{d === "all" ? "Todos os tipos" : XML_DOC_TYPE_LABEL[d]}</option>
          ))}
        </select>
        <select
          value={direction}
          onChange={(e) => setDirection(e.target.value as Direction | "all")}
          title="Direção da nota relativa à empresa (entrada = recebida; saída = emitida)"
          className="rounded border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-900 px-2 py-1 text-sm focus:border-rps-olive-dark focus:outline-none"
        >
          <option value="all">Entrada e saída</option>
          <option value="entrada">Entrada</option>
          <option value="saida">Saída</option>
        </select>
        <select
          value={healthFilter}
          onChange={(e) => setHealthFilter(e.target.value as HealthFilter)}
          title="Filtrar por saúde (% das notas pendentes)"
          className="rounded border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-900 px-2 py-1 text-sm focus:border-rps-olive-dark focus:outline-none"
        >
          {HEALTH_FILTERS.map((h) => (
            <option key={h.value} value={h.value}>{h.label}</option>
          ))}
        </select>
        <div className="flex items-center gap-1.5 text-sm text-gray-500">
          <select
            value={dateField}
            onChange={(e) => setDateField(e.target.value as DateField)}
            className="rounded border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-900 px-2 py-1 text-sm focus:border-rps-olive-dark focus:outline-none"
          >
            <option value="emissao">Data emissão</option>
            <option value="arrived">Data chegada</option>
            <option value="synced">Data sincronização</option>
            <option value="imported">Data importação</option>
          </select>
          <input
            type="date"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
            className="rounded border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-900 px-2 py-1 text-sm focus:border-rps-olive-dark focus:outline-none"
          />
          <span>até</span>
          <input
            type="date"
            value={to}
            onChange={(e) => setTo(e.target.value)}
            className="rounded border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-900 px-2 py-1 text-sm focus:border-rps-olive-dark focus:outline-none"
          />
          {(from || to) && (
            <button
              type="button"
              onClick={() => { setFrom(""); setTo(""); }}
              aria-label="Limpar filtro de data"
              className="rounded p-1 text-gray-400 hover:text-red-600 dark:hover:text-red-400"
            >
              <X className="h-3.5 w-3.5" aria-hidden />
            </button>
          )}
        </div>
        <span className="text-sm text-gray-500">
          {search.trim() !== debounced || q.isPlaceholderData
            ? "Buscando…"
            : `${empresaCount} empresa${empresaCount === 1 ? "" : "s"}`}
        </span>
        <button
          type="button"
          onClick={() => {
            if (flatRows.length === 0) {
              toast.info("Nenhuma empresa pra exportar.");
              return;
            }
            downloadCsv(`empresas-xml-${fileStamp()}`, toCsv(EMPRESA_CSV_HEADERS, flatRows.map(empresaToCsvRow)));
            toast.success(`${flatRows.length} linha(s) exportada(s).`);
          }}
          disabled={flatRows.length === 0}
          title="Exportar as empresas filtradas para CSV (abre no Excel)"
          className="ml-auto inline-flex items-center gap-1 rounded-full border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-900 px-2.5 py-1 text-xs text-gray-600 dark:text-gray-400 hover:border-rps-olive-dark hover:text-rps-olive-dark transition-colors disabled:opacity-50 disabled:pointer-events-none"
        >
          <Download className="h-3 w-3" aria-hidden />
          Exportar CSV
        </button>
        <SavedQueriesMenu storageKey={EMPRESAS_PRESETS_KEY} current={currentEmpresaPreset} onApply={applyEmpresaPreset} />
      </div>
      <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-gray-400">
        <span>Agrupado por empresa — clique no <ChevronRight className="inline h-3 w-3" aria-hidden /> para ver as filiais.</span>
        <span className="inline-flex items-center gap-1">
          Saúde (% pendente):
          <span className="inline-block h-2 w-2 rounded-full bg-green-500" aria-hidden /> &lt;10%
          <span className="ml-1 inline-block h-2 w-2 rounded-full bg-amber-500" aria-hidden /> 10–30%
          <span className="ml-1 inline-block h-2 w-2 rounded-full bg-red-500" aria-hidden /> &gt;30%
        </span>
      </p>
      <div className="relative">
        <TableLoadingOverlay isFetching={q.isPlaceholderData} />
      <Table stickyHeader>
      <THead sticky>
        {/* Empresa também é ordenável (A→Z / Z→A) */}
        <Th>
          <button
            type="button"
            onClick={() => toggleSort("empresa")}
            className={`inline-flex items-center gap-1 uppercase tracking-wider ${sort.key === "empresa" ? "text-gray-700 dark:text-gray-200" : "hover:text-gray-700 dark:hover:text-gray-300"}`}
          >
            Empresa
            <SortIcon active={sort.key === "empresa"} dir={sort.dir} />
          </button>
        </Th>
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
                <SortIcon active={active} dir={sort.dir} />
              </button>
            </Th>
          );
        })}
        <Th className="w-8" aria-label="Abrir" />
      </THead>
      <TBody>
        {shownGroups.map((g) => {
          const multi = g.filiais.length > 1;
          const isOpen = g.codigo_empresa != null && expanded.has(g.codigo_empresa);
          // Linha-mãe: soma das filiais (multi) ou a própria filial única.
          const parent = multi ? g.total : g.filiais[0];
          return (
            <Fragment key={g.key}>
              <Tr
                className="group cursor-pointer"
                title="Ver notas desta empresa"
                onClick={() => onDrill(parent, { dateField, from, to, docFilter, direction })}
              >
                <Td className="max-w-[300px] text-gray-700 dark:text-gray-300" title={g.isNoEmpresa ? undefined : g.nome}>
                  <span className="flex items-center gap-2">
                    {multi ? (
                      <button
                        type="button"
                        onClick={(ev) => { ev.stopPropagation(); toggleExpand(g.codigo_empresa as number); }}
                        aria-label={isOpen ? "Recolher filiais" : "Expandir filiais"}
                        aria-expanded={isOpen}
                        className="shrink-0 rounded text-gray-400 hover:text-rps-olive-dark"
                      >
                        {isOpen ? <ChevronDown className="h-4 w-4" aria-hidden /> : <ChevronRight className="h-4 w-4" aria-hidden />}
                      </button>
                    ) : (
                      <span className="w-4 shrink-0" aria-hidden />
                    )}
                    <span className="truncate">
                      {g.isNoEmpresa ? <span className="italic text-gray-500">Sem empresa</span> : g.nome}
                      {multi && <span className="ml-1 text-xs text-gray-400">· {g.filiais.length} filiais</span>}
                    </span>
                  </span>
                </Td>
                {numCells(parent)}
                <Td className="text-right">
                  <ChevronRight
                    className="ml-auto h-4 w-4 text-gray-300 transition group-hover:text-rps-olive-dark dark:text-gray-600"
                    aria-hidden
                  />
                </Td>
              </Tr>
              {multi && isOpen && g.filiais.map((f) => (
                <Tr
                  key={`${g.key}-${f.codigo_filial ?? "x"}`}
                  className="group cursor-pointer bg-gray-50/60 dark:bg-gray-900/40"
                  title="Ver notas desta filial"
                  onClick={() => onDrill(f, { dateField, from, to, docFilter, direction })}
                >
                  <Td className="max-w-[300px] text-gray-600 dark:text-gray-400">
                    {/* Indenta + rail à esquerda: as filiais consecutivas formam
                        uma linha vertical contínua, deixando claro que pertencem
                        à empresa-mãe acima. */}
                    <span className="ml-3 flex items-center gap-2 border-l-2 border-gray-200 pl-4 dark:border-gray-700">
                      <span className="truncate">Filial #{f.codigo_filial ?? 1}</span>
                    </span>
                  </Td>
                  {numCells(f)}
                  <Td className="text-right">
                    <ChevronRight
                      className="ml-auto h-4 w-4 text-gray-300 transition group-hover:text-rps-olive-dark dark:text-gray-600"
                      aria-hidden
                    />
                  </Td>
                </Tr>
              ))}
            </Fragment>
          );
        })}
        {q.isError && flatRows.length === 0 && <ErrorRow colSpan={numCols} onRetry={() => q.refetch()} />}
        {!q.isLoading && !q.isError && flatRows.length === 0 && (
          <EmptyRow colSpan={numCols}>
            {debounced
              ? `Nenhuma empresa encontrada para “${debounced}”.`
              : "Nenhuma empresa com notas rastreadas."}
          </EmptyRow>
        )}
        {q.isLoading && Array.from({ length: 8 }).map((_, i) => <SkeletonRow key={i} cols={numCols} />)}
      </TBody>
      </Table>
      </div>{/* /relative */}
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
  file_seen: "arquivo detectado",
  file_moved: "arquivo movido",
  imported: "importada",
  arrived: "chegou",
  synced: "sincronizada",
  sync_moved: "Sincronizada pelo tracker (arquivo posicionado)",
  sync_db_inserted: "Registrada no Athenas (aguardando importação)",
  sync_failed: "Falha na sincronização",
};

// event_type sem rótulo conhecido (o backend vai ganhar novos eventos nas
// próximas fases do shadow-sync) cai no fallback genérico: mostra o nome
// bruto em vez de escondê-lo ou quebrar a timeline.
function spanLabels(s: { stage: string; event_type: string }): { stage: string; event: string; unknown: boolean } {
  if (s.event_type === "seen_pending") {
    return { stage: "Aguardando importação", event: EVENT_LABEL.seen_pending, unknown: false };
  }
  const known = EVENT_LABEL[s.event_type];
  return {
    stage: STAGE_LABEL[s.stage] ?? s.stage,
    event: known ?? s.event_type,
    unknown: !known,
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
              <span className="inline-flex flex-wrap items-center gap-1.5">
                <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${XML_STATUS_STYLE[data.status]}`}>
                  {XML_STATUS_LABEL[data.status]}
                </span>
                <DirectionBadge direction={data.direction} />
                <ViaRoboBadge via_robo={data.via_robo} />
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

          <ParticipacoesSection participacoes={data.participacoes} />

          <h3 className="mb-2 text-sm font-semibold text-gray-700 dark:text-gray-300">Linha do tempo</h3>
          <ol className="relative space-y-3 border-l border-gray-200 pl-5 dark:border-gray-700">
            {data.spans.length === 0 && <li className="text-sm text-gray-500">Sem eventos.</li>}
            {data.spans.map((s, i) => {
              const l = spanLabels(s);
              const path = s.file_path_rede || s.file_path;
              const isFailure = s.event_type === "sync_failed";
              const erro = (s.payload?.erro as string | undefined) ?? undefined;
              const empresa = s.nome_empresa || (s.codigo_empresa ? `#${s.codigo_empresa}-${s.codigo_filial ?? 1}` : undefined);
              return (
                <li key={i} className="group relative">
                  <span
                    className={`absolute -left-[23px] top-1 h-2.5 w-2.5 rounded-full ${
                      isFailure ? "bg-red-600" : "bg-rps-olive-dark"
                    }`}
                  />
                  <p className={`text-sm font-medium ${isFailure ? "text-red-700 dark:text-red-400" : "text-gray-800 dark:text-gray-200"}`}>
                    {l.stage} <span className="text-xs font-normal text-gray-500">· {l.event}</span>
                    {l.unknown && (
                      <span className="ml-1 rounded bg-gray-200 px-1 py-0.5 text-[10px] font-normal text-gray-600 dark:bg-gray-700 dark:text-gray-300">
                        evento desconhecido
                      </span>
                    )}
                  </p>
                  <p className="text-xs text-gray-500">
                    {fmtTs(s.observed_at)} · {s.source}
                    {empresa && <> · {empresa}</>}
                  </p>
                  {isFailure && erro && (
                    <p className="mt-1 rounded border border-red-200 bg-red-50 px-2 py-1 text-[11px] text-red-700 dark:border-red-900/40 dark:bg-red-900/20 dark:text-red-400">
                      {erro}
                    </p>
                  )}
                  {path && (
                    <div className="flex items-start gap-1">
                      <p className="break-all text-[11px] text-gray-400">{path}</p>
                      <CopyButton text={path} label="caminho" />
                    </div>
                  )}
                  {l.unknown && s.payload && (
                    <pre className="mt-1 overflow-x-auto rounded bg-gray-50 px-2 py-1 text-[10px] text-gray-500 dark:bg-gray-800 dark:text-gray-400">
                      {JSON.stringify(s.payload)}
                    </pre>
                  )}
                </li>
              );
            })}
          </ol>
        </>
      )}
    </Modal>
  );
}

// Uma nota pode envolver 2+ empresas clientes (emitente=saída, destinatário=
// entrada), cada uma com seu próprio ciclo de importação no Athenas. null/
// ausente/vazio = "sem participações conhecidas" (nota ainda não re-derivada
// pelo shadow-sync) — não é erro, não renderiza a seção.
function ParticipacoesSection({ participacoes }: { participacoes?: Participacao[] | null }) {
  if (!participacoes || participacoes.length === 0) return null;

  const importadas = participacoes.filter((p) => p.status === "imported").length;

  return (
    <div className="mb-5">
      <h3 className="mb-2 flex items-center gap-2 text-sm font-semibold text-gray-700 dark:text-gray-300">
        Participações
        {participacoes.length > 1 && (
          <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-medium text-amber-800 dark:bg-amber-900/40 dark:text-amber-300">
            importada {importadas}/{participacoes.length}
          </span>
        )}
      </h3>
      <div className="space-y-2">
        {participacoes.map((p, i) => (
          <div
            key={i}
            className="rounded border border-gray-200 p-2.5 text-xs dark:border-gray-800"
          >
            <div className="mb-1 flex flex-wrap items-center gap-1.5">
              <span className="text-sm font-medium text-gray-800 dark:text-gray-200">
                {p.nome_empresa || `#${p.codigo_empresa}-${p.codigo_filial}`}
              </span>
              <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${XML_STATUS_STYLE[p.status]}`}>
                {XML_STATUS_LABEL[p.status]}
              </span>
              <DirectionBadge direction={p.direction} />
              {p.papel && (
                <span className="rounded bg-gray-100 px-1.5 py-0.5 text-[11px] text-gray-600 dark:bg-gray-800 dark:text-gray-400">
                  {p.papel === "emitente" ? "Emitente" : "Destinatário"}
                </span>
              )}
            </div>
            {p.motivo_ignorado && (
              <p className="text-gray-500">Motivo: {p.motivo_ignorado}</p>
            )}
            <p className="text-gray-400">
              {[
                p.pending_at && `pendente ${fmtTs(p.pending_at)}`,
                p.synced_at && `sincronizada ${fmtTs(p.synced_at)}`,
                p.imported_at && `importada ${fmtTs(p.imported_at)}`,
              ]
                .filter(Boolean)
                .join(" · ") || "—"}
            </p>
          </div>
        ))}
      </div>
    </div>
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

// ── Modo Apresentação (TV / vitrine) ──────────────────────────────────────────
// Overlay em tela cheia que gira os principais indicadores do Rastreador XML pra
// exibição contínua numa TV. Tema escuro forçado (wrapper .dark), fontes grandes,
// dados atualizando sozinhos. Abre por botão (com fullscreen) ou via ?present=1.

const PRESENT_SLIDES = ["Resumo geral", "Distribuição por status", "Idade do backlog", "Top empresas & tendência"];
const PRESENT_INTERVAL_MS = 15_000;

// Mantém a tela acesa enquanto a apresentação está ativa (best-effort).
function useWakeLock(active: boolean) {
  useEffect(() => {
    if (!active) return;
    let released = false;
    let lock: { release?: () => Promise<void> } | null = null;
    const nav = navigator as Navigator & { wakeLock?: { request: (t: string) => Promise<typeof lock> } };
    nav.wakeLock
      ?.request("screen")
      .then((l) => { if (released) l?.release?.(); else lock = l; })
      .catch(() => {});
    return () => { released = true; lock?.release?.().catch(() => {}); };
  }, [active]);
}

function BigStat({ label, value, accent }: { label: string; value?: number; accent?: string }) {
  return (
    <div className="flex flex-col justify-center rounded-xl border border-gray-800 bg-gray-900 p-6">
      <p className="text-sm uppercase tracking-wider text-gray-400">{label}</p>
      <p
        className={`mt-2 text-5xl font-bold tabular-nums ${accent ?? "text-gray-100"}`}
        title={value != null ? fmtFull(value) : undefined}
      >
        {value != null ? fmtCompact(value) : "—"}
      </p>
    </div>
  );
}


function SlideResumo({ ov, latency }: { ov?: Overview; latency?: LatencyMetrics }) {
  const pendentes = ov ? ov.arrived + ov.synced + ov.pending_import : 0;
  const a2s = latency?.arrival_to_sync;
  const s2i = latency?.sync_to_import;
  const t1 = a2s && a2s.count > 0 && a2s.p50_s != null ? slaTone(a2s.p50_s) : "none";
  const good2 = !!s2i && s2i.same_day_pct >= 95;
  return (
    <div className="flex h-full flex-col justify-center gap-5">
      <div className="grid grid-cols-5 gap-4">
        <BigStat label="A Sincronizar" value={ov?.arrived} accent="text-yellow-400" />
        <BigStat label="Sincronizadas" value={ov?.synced} accent="text-sky-400" />
        <BigStat label="Aguardando Importação" value={ov?.pending_import} accent="text-amber-400" />
        <BigStat label="Importadas hoje" value={ov?.imported_today} accent="text-rps-sage" />
        <BigStat label="Ignoradas" value={ov?.import_ignored} />
      </div>
      <div className="grid min-h-[280px] grid-cols-3 gap-4">
        <div className="flex flex-col justify-center rounded-xl border border-gray-800 bg-gray-900 p-6">
          <p className="text-sm uppercase tracking-wider text-gray-400">Backlog pendente</p>
          <p className="mt-2 text-7xl font-bold tabular-nums text-gray-100" title={fmtFull(pendentes)}>{fmtCompact(pendentes)}</p>
          <p className="mt-1 text-base text-gray-500">
            {ov ? fmtCompact(ov.in_transit) : "—"} em trânsito
          </p>
        </div>
        <div className="flex flex-col justify-center rounded-xl border border-gray-800 bg-gray-900 p-6">
          <p className="text-sm uppercase tracking-wider text-gray-400">Fila de sincronização (7d)</p>
          {a2s && a2s.count > 0 && a2s.p50_s != null ? (
            <>
              <div className="mt-2 flex items-baseline gap-3">
                <span className={`h-4 w-4 shrink-0 self-center rounded-full ${SLA_DOT[t1]}`} aria-hidden />
                <span className={`text-5xl font-bold ${SLA_VALUE[t1]}`}>{fmtLatHuman(a2s.p50_s)}</span>
                <span className="text-base text-gray-400">p50 · p95: {a2s.p95_s != null ? fmtLatHuman(a2s.p95_s) : "—"}</span>
              </div>
              <p className="mt-1 text-base text-gray-500">{fmtFull(a2s.count)} sincronizadas em 7 dias</p>
            </>
          ) : (
            <p className="mt-2 text-3xl font-bold text-gray-500">sem dados</p>
          )}
        </div>
        <div className="flex flex-col justify-center rounded-xl border border-gray-800 bg-gray-900 p-6">
          <p className="text-sm uppercase tracking-wider text-gray-400">Importação pós-sync (7d)</p>
          {s2i && s2i.count > 0 ? (
            <>
              <div className="mt-2 flex items-baseline gap-3">
                <span className={`h-4 w-4 shrink-0 self-center rounded-full ${good2 ? "bg-green-500" : "bg-amber-500"}`} aria-hidden />
                <span className={`text-5xl font-bold ${good2 ? "text-green-400" : "text-amber-400"}`}>{fmtPct1(s2i.same_day_pct)}%</span>
                <span className="text-base text-gray-400">no mesmo dia</span>
              </div>
              <p className="mt-1 text-base text-gray-500">D+1: {fmtFull(s2i.d1)} · D+2+: {fmtFull(s2i.d2_plus)} de {fmtFull(s2i.count)}</p>
            </>
          ) : (
            <p className="mt-2 text-3xl font-bold text-gray-500">sem dados</p>
          )}
        </div>
      </div>
    </div>
  );
}

function SlideStatus({ ov }: { ov?: Overview }) {
  const bars = PAINEL_STATUSES.filter((s) => s !== "imported");
  const counts = ov ? bars.map((s) => ({ status: s, count: statusCount(ov, s) })) : [];
  const max = Math.max(1, ...counts.map((c) => c.count));
  return (
    <div className="mx-auto flex h-full w-full max-w-[1600px] flex-col justify-center gap-5">
      {counts.map((c) => (
        <div key={c.status} className="flex items-center gap-6">
          <span className="w-72 shrink-0 text-2xl font-medium text-gray-200">{XML_STATUS_LABEL[c.status]}</span>
          <div className="h-7 flex-1 overflow-hidden rounded-full bg-gray-800">
            <div className={`h-full rounded-full ${STATUS_BAR_FILL[c.status]}`} style={{ width: `${(c.count / max) * 100}%` }} />
          </div>
          <span className="w-56 shrink-0 whitespace-nowrap text-right text-4xl font-bold tabular-nums text-gray-100" title={fmtFull(c.count)}>
            {fmtCompact(c.count)}
          </span>
        </div>
      ))}
      <p className="mt-2 text-lg text-gray-500">
        Importadas (total): <b className="text-rps-sage">{ov ? fmtCompact(ov.imported) : "—"}</b>
      </p>
    </div>
  );
}

function BigAgingCol({ title, buckets }: { title: string; buckets: AgingBucket[] }) {
  const max = Math.max(1, ...buckets.map((b) => b.count));
  return (
    <div>
      <p className="mb-4 text-xl font-medium text-gray-300">{title}</p>
      <ul className="space-y-3">
        {buckets.map((b) => (
          <li key={b.label} className="flex items-center gap-4">
            <span className="w-16 shrink-0 text-lg tabular-nums text-gray-400">{b.label}</span>
            <div className="h-5 flex-1 overflow-hidden rounded-full bg-gray-800">
              <div className={`h-full rounded-full ${AGE_BUCKET_FILL[b.label] ?? "bg-gray-500"}`} style={{ width: `${(b.count / max) * 100}%` }} />
            </div>
            <span className="w-32 shrink-0 whitespace-nowrap text-right text-3xl font-bold tabular-nums text-gray-100" title={fmtFull(b.count)}>
              {fmtCompact(b.count)}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function SlideAging({ data }: { data?: Aging }) {
  if (!data || (data.to_sync.length === 0 && data.to_import.length === 0)) {
    return <div className="flex h-full items-center justify-center text-3xl text-gray-500">Sem backlog pendente. 🎉</div>;
  }
  return (
    <div className="grid h-full grid-cols-2 items-center gap-12 px-4">
      <BigAgingCol title="Aguardando sincronização" buckets={data.to_sync} />
      <BigAgingCol title="Aguardando importação" buckets={data.to_import} />
    </div>
  );
}

function SlideEmpresasTrend({
  empresas,
  ts,
  tsLoading,
  tsError,
}: {
  empresas?: { items: EmpresaAgg[] };
  ts?: Timeseries;
  tsLoading: boolean;
  tsError: boolean;
}) {
  const pend = (e: EmpresaAgg) => e.arrived + e.synced + e.pending_import;
  const top = [...(empresas?.items ?? [])]
    .filter((e) => e.codigo_empresa != null && pend(e) > 0)
    .sort((a, b) => pend(b) - pend(a))
    .slice(0, 8);
  const maxPend = Math.max(1, ...top.map(pend));
  const buckets = ts?.buckets ?? [];
  const series: ChartSeries[] = VOLUME_META.map((m) => ({
    label: m.label, strokeCls: m.strokeCls, fillCls: m.fillCls, swatchCls: m.swatchCls,
    values: buckets.map((b) => b[m.key]),
  }));
  return (
    <div className="flex h-full items-center">
      <div className="grid w-full grid-cols-2 gap-10">
        <div>
          <p className="mb-4 text-xl font-medium text-gray-300">Empresas com mais pendentes</p>
          <ul className="space-y-3">
            {top.length === 0 ? (
              <li className="text-2xl text-gray-500">Nenhuma empresa pendente. 🎉</li>
            ) : top.map((e) => (
              <li key={`${e.codigo_empresa}-${e.codigo_filial ?? "x"}`} className="flex items-center gap-4">
                <span className="w-64 shrink-0 truncate text-lg text-gray-200" title={e.nome_empresa}>
                  {e.nome_empresa || `#${e.codigo_empresa}-${e.codigo_filial ?? 1}`}
                </span>
                <div className="h-4 flex-1 overflow-hidden rounded-full bg-gray-800">
                  <div className="h-full rounded-full bg-rps-sage" style={{ width: `${(pend(e) / maxPend) * 100}%` }} />
                </div>
                <span className="w-24 shrink-0 whitespace-nowrap text-right text-2xl font-bold tabular-nums text-gray-100" title={fmtFull(pend(e))}>
                  {fmtCompact(pend(e))}
                </span>
              </li>
            ))}
          </ul>
        </div>
        <div className="flex flex-col">
          <p className="mb-4 text-xl font-medium text-gray-300">Volume por dia (30d)</p>
          {tsError ? (
            <div className="flex h-64 items-center justify-center text-xl text-gray-500">Tendência indisponível no tracker.</div>
          ) : tsLoading && buckets.length === 0 ? (
            <div className="flex h-64 items-center justify-center text-xl text-gray-500">Carregando série…</div>
          ) : chartHasData(series) ? (
            <>
              <LineChart series={series} xLabels={buckets.map((b) => ddmm(b.date))} height={260} formatY={(n) => fmtCompact(Math.round(n))} formatTip={(n) => fmtFull(Math.round(n))} />
              <ChartLegend series={series} />
            </>
          ) : (
            <div className="flex h-64 items-center justify-center text-xl text-gray-500">Sem série no período.</div>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Modo Mural (tela única) ───────────────────────────────────────────────────
// Tudo numa tela só, pra TVs grandes. Versão compacta dos slides em 2×2 painéis
// + faixa de cards. Reusa AgingBars (pequeno) e os helpers/cores.
function MuralStat({ label, value, accent }: { label: string; value?: number; accent?: string }) {
  return (
    <div className="rounded-lg border border-gray-800 bg-gray-900 px-4 py-3">
      <p className="text-xs uppercase tracking-wider text-gray-500">{label}</p>
      <p className={`mt-1 text-3xl font-bold tabular-nums ${accent ?? "text-gray-100"}`} title={value != null ? fmtFull(value) : undefined}>
        {value != null ? fmtCompact(value) : "—"}
      </p>
    </div>
  );
}

function MuralPanel({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="flex min-h-0 flex-col overflow-hidden rounded-xl border border-gray-800 bg-gray-900 p-5">
      <p className="mb-3 shrink-0 text-sm font-semibold uppercase tracking-wider text-gray-400">{title}</p>
      <div className="min-h-0 flex-1">{children}</div>
    </div>
  );
}

function SlideMural({ ov, empresas, aging, latency }: { ov?: Overview; empresas?: { items: EmpresaAgg[] }; aging?: Aging; latency?: LatencyMetrics }) {
  const pendentes = ov ? ov.arrived + ov.synced + ov.pending_import : 0;
  const a2s = latency?.arrival_to_sync;
  const s2i = latency?.sync_to_import;
  const bars = PAINEL_STATUSES.filter((s) => s !== "imported");
  const counts = ov ? bars.map((s) => ({ status: s, count: statusCount(ov, s) })) : [];
  const maxC = Math.max(1, ...counts.map((c) => c.count));
  const pend = (e: EmpresaAgg) => e.arrived + e.synced + e.pending_import;
  const top = [...(empresas?.items ?? [])]
    .filter((e) => e.codigo_empresa != null && pend(e) > 0)
    .sort((a, b) => pend(b) - pend(a))
    .slice(0, 6);
  const maxP = Math.max(1, ...top.map(pend));
  return (
    <div className="flex h-full flex-col gap-4">
      <div className="grid grid-cols-5 gap-3">
        <MuralStat label="A Sincronizar" value={ov?.arrived} accent="text-yellow-400" />
        <MuralStat label="Sincronizadas" value={ov?.synced} accent="text-sky-400" />
        <MuralStat label="Aguardando Importação" value={ov?.pending_import} accent="text-amber-400" />
        <MuralStat label="Importadas hoje" value={ov?.imported_today} accent="text-rps-sage" />
        <MuralStat label="Ignoradas" value={ov?.import_ignored} />
      </div>
      <div className="grid min-h-0 flex-1 grid-cols-2 grid-rows-2 gap-4">
        <MuralPanel title="Backlog & latência (7d)">
          <div className="flex h-full items-center gap-10">
            <div>
              <p className="text-xs uppercase tracking-wider text-gray-500">Backlog pendente</p>
              <p className="text-6xl font-bold tabular-nums text-gray-100" title={fmtFull(pendentes)}>{fmtCompact(pendentes)}</p>
              <p className="mt-1 text-sm text-gray-500">{ov ? fmtCompact(ov.in_transit) : "—"} em trânsito</p>
            </div>
            <div className="space-y-4">
              <div>
                <p className="text-xs uppercase tracking-wider text-gray-500">Fila de sincronização</p>
                {a2s && a2s.count > 0 && a2s.p50_s != null ? (
                  <div className="flex items-baseline gap-2">
                    <span className={`h-2.5 w-2.5 shrink-0 self-center rounded-full ${SLA_DOT[slaTone(a2s.p50_s)]}`} aria-hidden />
                    <span className={`text-2xl font-bold ${SLA_VALUE[slaTone(a2s.p50_s)]}`}>{fmtLatHuman(a2s.p50_s)}</span>
                    <span className="text-xs text-gray-500">p50 · p95 {a2s.p95_s != null ? fmtLatHuman(a2s.p95_s) : "—"}</span>
                  </div>
                ) : (
                  <p className="text-xl font-bold text-gray-500">sem dados</p>
                )}
              </div>
              <div>
                <p className="text-xs uppercase tracking-wider text-gray-500">Importação pós-sync</p>
                {s2i && s2i.count > 0 ? (
                  <div className="flex items-baseline gap-2">
                    <span className={`h-2.5 w-2.5 shrink-0 self-center rounded-full ${s2i.same_day_pct >= 95 ? "bg-green-500" : "bg-amber-500"}`} aria-hidden />
                    <span className={`text-2xl font-bold ${s2i.same_day_pct >= 95 ? "text-green-400" : "text-amber-400"}`}>{fmtPct1(s2i.same_day_pct)}%</span>
                    <span className="text-xs text-gray-500">no mesmo dia</span>
                  </div>
                ) : (
                  <p className="text-xl font-bold text-gray-500">sem dados</p>
                )}
              </div>
            </div>
          </div>
        </MuralPanel>

        <MuralPanel title="Distribuição por status">
          <ul className="flex h-full flex-col justify-center gap-2.5">
            {counts.map((c) => (
              <li key={c.status} className="flex items-center gap-3">
                <span className="w-44 shrink-0 truncate text-sm text-gray-300">{XML_STATUS_LABEL[c.status]}</span>
                <div className="h-3 flex-1 overflow-hidden rounded-full bg-gray-800">
                  <div className={`h-full rounded-full ${STATUS_BAR_FILL[c.status]}`} style={{ width: `${(c.count / maxC) * 100}%` }} />
                </div>
                <span className="w-24 shrink-0 whitespace-nowrap text-right text-xl font-bold tabular-nums text-gray-100" title={fmtFull(c.count)}>{fmtCompact(c.count)}</span>
              </li>
            ))}
          </ul>
        </MuralPanel>

        <MuralPanel title="Idade do backlog">
          <div className="grid h-full grid-cols-2 items-center gap-6">
            <AgingBars title="Aguardando sincronização" buckets={aging?.to_sync ?? []} />
            <AgingBars title="Aguardando importação" buckets={aging?.to_import ?? []} />
          </div>
        </MuralPanel>

        <MuralPanel title="Empresas com mais pendentes">
          <ul className="flex h-full flex-col justify-center gap-2.5">
            {top.length === 0 ? (
              <li className="text-lg text-gray-500">Nenhuma empresa pendente. 🎉</li>
            ) : top.map((e) => (
              <li key={`${e.codigo_empresa}-${e.codigo_filial ?? "x"}`} className="flex items-center gap-3">
                <span className="w-48 shrink-0 truncate text-sm text-gray-300" title={e.nome_empresa}>{e.nome_empresa || `#${e.codigo_empresa}-${e.codigo_filial ?? 1}`}</span>
                <div className="h-3 flex-1 overflow-hidden rounded-full bg-gray-800">
                  <div className="h-full rounded-full bg-rps-sage" style={{ width: `${(pend(e) / maxP) * 100}%` }} />
                </div>
                <span className="w-20 shrink-0 whitespace-nowrap text-right text-xl font-bold tabular-nums text-gray-100" title={fmtFull(pend(e))}>{fmtCompact(pend(e))}</span>
              </li>
            ))}
          </ul>
        </MuralPanel>
      </div>
    </div>
  );
}

function PresentationMode({ initialMode, onClose }: { initialMode: "slides" | "mural"; onClose: () => void }) {
  const overview = useQuery({ queryKey: ["xml", "present", "overview"], queryFn: () => xmlMetricsApi.overview().then((r) => r.data), refetchInterval: 15_000 });
  const empresas = useQuery({ queryKey: ["xml", "empresas", "painel"], queryFn: () => empresasApi.list({ limit: 0 }).then((r) => r.data), refetchInterval: 30_000 });
  const aging = useQuery({ queryKey: ["xml", "aging", "painel"], queryFn: () => xmlMetricsApi.aging().then((r) => r.data), refetchInterval: 60_000 });
  const ts = useQuery({ queryKey: ["xml", "timeseries", "30d"], queryFn: () => xmlMetricsApi.timeseries("30d", "day").then((r) => r.data), refetchInterval: 60_000 });
  const latency = useQuery({ queryKey: ["xml", "latency", 7], queryFn: () => xmlMetricsApi.latency(7).then((r) => r.data), refetchInterval: 60_000 });

  const [mode, setMode] = useState<"slides" | "mural">(initialMode);
  const [slide, setSlide] = useState(0);
  const [now, setNow] = useState(() => new Date());
  useWakeLock(true);

  // Giro automático só no modo slides; o mural mostra tudo de uma vez.
  useEffect(() => {
    if (mode !== "slides") return;
    const id = setInterval(() => setSlide((s) => (s + 1) % PRESENT_SLIDES.length), PRESENT_INTERVAL_MS);
    return () => clearInterval(id);
  }, [mode]);
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      else if (e.key === "ArrowRight") setSlide((s) => (s + 1) % PRESENT_SLIDES.length);
      else if (e.key === "ArrowLeft") setSlide((s) => (s - 1 + PRESENT_SLIDES.length) % PRESENT_SLIDES.length);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const ov = overview.data;
  const erroredAll = overview.isError && aging.isError;

  return (
    <div className="dark fixed inset-0 z-50 flex flex-col bg-gray-950 text-gray-100">
      <header className="flex items-center justify-between border-b border-gray-800 px-8 py-4">
        <div className="flex items-baseline gap-3">
          <RadioTower className="h-6 w-6 shrink-0 self-center text-rps-sage" aria-hidden />
          <span className="text-2xl font-semibold">Rastreador XML</span>
          <span className="text-lg text-gray-400">· {mode === "mural" ? "Visão geral" : PRESENT_SLIDES[slide]}</span>
        </div>
        <div className="flex items-center gap-6">
          <span className="tabular-nums text-3xl font-semibold">{now.toLocaleTimeString("pt-BR")}</span>
          {/* Toggle Slides | Mural */}
          <div className="inline-flex rounded-md border border-gray-700 bg-gray-900 p-0.5 text-sm">
            {(["slides", "mural"] as const).map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => setMode(m)}
                className={`rounded px-3 py-1 font-medium transition-colors ${mode === m ? "bg-rps-olive-dark text-white" : "text-gray-400 hover:text-white"}`}
              >
                {m === "slides" ? "Slides" : "Mural"}
              </button>
            ))}
          </div>
          {mode === "slides" && (
            <div className="flex gap-2">
              {PRESENT_SLIDES.map((s, i) => (
                <span key={s} className={`h-2.5 w-2.5 rounded-full ${i === slide ? "bg-rps-sage" : "bg-gray-700"}`} aria-hidden />
              ))}
            </div>
          )}
          <button
            type="button"
            onClick={() => document.documentElement.requestFullscreen?.().catch(() => {})}
            className="rounded p-1.5 text-gray-400 hover:text-white"
            aria-label="Tela cheia"
          >
            <Maximize2 className="h-5 w-5" aria-hidden />
          </button>
          <button type="button" onClick={onClose} className="rounded p-1.5 text-gray-400 hover:text-white" aria-label="Sair da apresentação">
            <X className="h-6 w-6" aria-hidden />
          </button>
        </div>
      </header>

      <main className="flex-1 overflow-hidden p-10">
        {erroredAll ? (
          <div className="flex h-full items-center justify-center text-3xl text-gray-500">Rastreador indisponível — reconectando…</div>
        ) : mode === "mural" ? (
          <SlideMural ov={ov} empresas={empresas.data} aging={aging.data} latency={latency.data} />
        ) : slide === 0 ? (
          <SlideResumo ov={ov} latency={latency.data} />
        ) : slide === 1 ? (
          <SlideStatus ov={ov} />
        ) : slide === 2 ? (
          <SlideAging data={aging.data} />
        ) : (
          <SlideEmpresasTrend empresas={empresas.data} ts={ts.data} tsLoading={ts.isLoading} tsError={ts.isError} />
        )}
      </main>

      <footer className="px-8 py-2 text-center text-sm text-gray-600">
        RPS Contabilidade · atualização automática · {mode === "slides" ? "← → troca slide · " : ""}Esc para sair
      </footer>
    </div>
  );
}
