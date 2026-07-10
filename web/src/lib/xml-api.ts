// Cliente da API do rps-xml-tracker (serviço separado do backend do maestro).
// Reusa o MESMO token JWT do maestro (SSO), mas aponta para a base URL própria
// do tracker (NEXT_PUBLIC_XML_API_URL). Mantido à parte do `api` do maestro
// porque é outro host/porta.
import axios from "axios";

const XML_BASE_URL =
  process.env.NEXT_PUBLIC_XML_API_URL ?? "http://localhost:8090/api/v1";

export const xmlApi = axios.create({ baseURL: XML_BASE_URL });

xmlApi.interceptors.request.use((config) => {
  const token = typeof window !== "undefined" ? localStorage.getItem("token") : null;
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

xmlApi.interceptors.response.use(
  (r) => r,
  (err) => {
    if (err.response?.status === 401 && typeof window !== "undefined") {
      localStorage.removeItem("token");
      window.location.href = "/login";
    }
    return Promise.reject(err);
  }
);

// ── Types ────────────────────────────────────────────────────────────────────

export type DocType = "NFE" | "NFCE" | "CTE" | "NFS" | "EVENTO" | "UNKNOWN";

// Direção da nota relativa à empresa monitorada: saída = empresa é emitente;
// entrada = empresa é destinatária. Omitido quando indeterminada (sem empresa
// ou CNPJ que não casa). Intra-grupo (emitente E destinatária) → "saida".
export type Direction = "entrada" | "saida";

export type NotaStatus =
  | "arrived"
  | "synced"
  | "imported"
  | "import_ignored"
  | "pending_import";

export interface Nota {
  chave_acesso: string;
  numero_nota?: string; // nNF derivado da chave; vazio p/ NFSe
  // Presente em notas importadas: true = importado por robô (DATAROBO no Athenas),
  // false = importado manualmente. Undefined/ausente = status não é "imported".
  via_robo?: boolean;
  doc_type: DocType;
  direction?: Direction; // omitido quando indeterminada
  status: NotaStatus;
  codigo_empresa?: number;
  codigo_filial?: number;
  nome_empresa?: string;
  cnpj_emitente?: string;
  nome_emitente?: string;
  cnpj_destinatario?: string;
  nome_destinatario?: string;
  import_ignored: boolean;
  motivo_ignorado?: string;
  data_emissao?: string;
  valor_total?: number;
  arrived_at?: string;
  synced_at?: string;
  imported_at?: string;
  lat_arrival_sync_s?: number;
  lat_sync_import_s?: number;
}

export interface Span {
  stage: "arrival" | "sync" | "import";
  event_type: string;
  observed_at: string;
  source: string;
  file_path?: string;
  file_path_rede?: string;
  // Presentes nos eventos do syncer (stage "sync") — multi-participação emite
  // um span por empresa, então precisam vir junto pra não parecer duplicado.
  codigo_empresa?: number;
  codigo_filial?: number;
  nome_empresa?: string;
  payload?: Record<string, unknown>;
}

// Participação de UMA empresa cliente numa nota (shadow-sync M0). Uma mesma
// chave pode ter 2+ participações (emitente=saída, destinatário=entrada),
// cada uma com seu PRÓPRIO ciclo de importação no Athenas — o status da nota
// é o agregado (só termina quando TODAS as participações terminam).
export interface Participacao {
  codigo_empresa: number;
  codigo_filial: number; // 0 = desconhecida na linha do Athenas
  nome_empresa?: string;
  papel?: "emitente" | "destinatario"; // omitido se indeterminado
  direction?: Direction;
  status: NotaStatus;
  motivo_ignorado?: string;
  pending_at?: string;
  imported_at?: string;
  synced_at?: string; // F1: quando o syncer posicionou a cópia desta empresa
  sync_url?: string;
}

export interface NotaDetail extends Nota {
  spans: Span[];
  // M0: null/ausente/vazio em notas antigas ainda não re-derivadas — tratar os
  // três como "sem participações conhecidas" (não é erro, não renderizar).
  participacoes?: Participacao[] | null;
}

export interface NotaListResponse {
  items: Nota[];
  total: number;
  limit: number;
  offset: number;
}

export interface Overview {
  arrived: number;
  synced: number;
  imported: number;
  import_ignored: number;
  pending_import: number;
  // "flow" só quando há janela de data (contagens do recorte, não estoque).
  // Ausente = snapshot do estado atual.
  mode?: "flow";
  in_transit: number;
  imported_today: number; // sempre global (hoje)
  lat_arrival_sync_p50_s?: number; // sempre 30d
  lat_arrival_sync_p95_s?: number;
  lat_sync_import_p50_s?: number;
  lat_sync_import_p95_s?: number;
}

// Filtro do /metrics/overview (item #5). Sem nada = snapshot global. Com janela
// (date_field+from/to) e/ou filtros = recompute por status no recorte (mode:flow
// quando há janela). NÃO aceita direction (coluna só existe em notas/empresas).
export interface OverviewFilter {
  date_field?: DateField;
  from?: string;
  to?: string;
  codigo_empresa?: number;
  codigo_filial?: number;
  doc_type?: DocType;
}

// Aging do backlog (GET /metrics/aging, item #4). Faixas de idade do que está
// pendente, ancorado no evento que iniciou a espera (to_sync = arrived_at;
// to_import = synced_at). `max_days` = limite superior exclusivo (ausente na
// faixa aberta >30d).
export interface AgingBucket {
  label: string;
  max_days?: number;
  count: number;
}
export interface Aging {
  anchor_to_sync: string;
  anchor_to_import: string;
  to_sync: AgingBucket[];
  to_import: AgingBucket[];
}
export interface AgingFilter {
  codigo_empresa?: number;
  codigo_filial?: number;
  doc_type?: DocType;
  direction?: Direction;
}

// Latência do pipeline (GET /metrics/latency?days=). Substitui os lat_* do
// overview (removidos). Valores em SEGUNDOS. p50_s/p95_s = null quando count=0.
export interface LatencyDailyPoint {
  date: string; // YYYY-MM-DD
  count: number;
  p50_s: number | null;
  p95_s: number | null;
}
export interface LatencyMetrics {
  days: number;
  tz: string;
  // Espera na fila de sincronização (chegada → sincronizado), em segundos.
  arrival_to_sync: {
    count: number;
    p50_s: number | null;
    p95_s: number | null;
    daily: LatencyDailyPoint[];
  };
  // Importação pós-sync: distribuição por dias (resolução diária).
  sync_to_import: {
    count: number;
    same_day: number;
    d1: number;
    d2_plus: number;
    same_day_pct: number;
    d1_pct: number;
    d2_plus_pct: number;
  };
}

export interface EmpresaAgg {
  // Ausentes (omitempty) na linha "Sem empresa" — detectar com `codigo_empresa == null`.
  codigo_empresa?: number;
  codigo_filial?: number;
  nome_empresa?: string;
  in_transit: number;
  arrived: number;
  synced: number;
  imported: number;
  import_ignored: number;
  pending_import: number;
}

export type DateField = "emissao" | "arrived" | "synced" | "imported";

// Série temporal do tracker (GET /metrics/timeseries). Contagens são "fluxo por
// evento no dia" (arrived = chegaram naquele dia, etc.); latências são percentis
// por coorte do evento de origem (chegada p/ arrival→sync, sync p/ sync→import).
// Latências vêm nullable: null = sem transição completa no dia (vira gap na
// linha). Os dias mais recentes podem ser parciais (viés de censura à direita:
// notas que chegaram mas ainda não sincronizaram saem do percentil).
export type TimeseriesRange = "7d" | "30d" | "90d";
export type TimeseriesBucket = "day" | "week";

export interface TimeseriesPoint {
  date: string; // YYYY-MM-DD no fuso local (America/Sao_Paulo); week = segunda-feira
  arrived: number;
  synced: number;
  imported: number;
  import_ignored: number;
  lat_arrival_sync_p50_s: number | null;
  lat_arrival_sync_p95_s: number | null;
  lat_sync_import_p50_s: number | null;
  lat_sync_import_p95_s: number | null;
}

export interface Timeseries {
  range: TimeseriesRange;
  bucket: TimeseriesBucket;
  tz: string;
  buckets: TimeseriesPoint[];
}

export interface NotaListFilter {
  status?: NotaStatus;
  doc_type?: DocType;
  codigo_empresa?: number;
  codigo_filial?: number;
  sem_empresa?: boolean; // notas com codigo_empresa IS NULL
  empresa?: string; // busca por nome
  cnpj?: string; // emitente ou destinatário
  q?: string; // chave de acesso
  numero?: string; // número da nota (nNF), match por prefixo — separado de `q`
  direction?: Direction; // entrada/saída relativa à empresa
  date_field?: DateField;
  from?: string; // yyyy-mm-dd
  to?: string;
  limit?: number;
  offset?: number;
}

// ── Endpoints ────────────────────────────────────────────────────────────────

// Apuração do filtro atual (GET /notas/summary): mesmos filtros de /notas,
// devolve contagem + soma dos valores. Não pagina.
export interface NotaSummary {
  count: number;
  valor_total: number;
}

export const notasApi = {
  list: (f: NotaListFilter = {}) =>
    xmlApi.get<NotaListResponse>("/notas", { params: cleanParams(f) }),
  // Mesmos filtros da lista, sem paginação (limit/offset viram undefined →
  // cleanParams os remove).
  summary: (f: NotaListFilter = {}) =>
    xmlApi.get<NotaSummary>("/notas/summary", { params: cleanParams({ ...f, limit: undefined, offset: undefined }) }),
  get: (chave: string) => xmlApi.get<NotaDetail>(`/notas/${chave}`),
};

export const xmlMetricsApi = {
  // Sem filtro = snapshot global (chave de cache fixa no tracker). Com janela/
  // filtros = recompute no recorte (mode:flow quando há janela).
  overview: (f: OverviewFilter = {}) => {
    const params: Record<string, string | number> = {};
    if (f.from || f.to) {
      if (f.date_field) params.date_field = f.date_field;
      if (f.from) params.from = f.from;
      if (f.to) params.to = f.to;
    }
    if (f.codigo_empresa != null) params.codigo_empresa = f.codigo_empresa;
    if (f.codigo_filial != null) params.codigo_filial = f.codigo_filial;
    if (f.doc_type) params.doc_type = f.doc_type;
    return xmlApi.get<Overview>("/metrics/overview", { params });
  },
  aging: (f: AgingFilter = {}) => {
    const params: Record<string, string | number> = {};
    if (f.codigo_empresa != null) params.codigo_empresa = f.codigo_empresa;
    if (f.codigo_filial != null) params.codigo_filial = f.codigo_filial;
    if (f.doc_type) params.doc_type = f.doc_type;
    if (f.direction) params.direction = f.direction;
    return xmlApi.get<Aging>("/metrics/aging", { params });
  },
  timeseries: (range: TimeseriesRange = "30d", bucket: TimeseriesBucket = "day") =>
    xmlApi.get<Timeseries>("/metrics/timeseries", { params: { range, bucket } }),
  // Latência do pipeline (endpoint novo, substitui os campos lat_* do overview
  // que agora vêm null). days = 1..90, default 7.
  latency: (days = 7) =>
    xmlApi.get<LatencyMetrics>("/metrics/latency", { params: { days } }),
};

export const empresasApi = {
  // limit=0 devolve TODAS as linhas (empresas/filiais + a linha "Sem empresa"),
  // pra ordenar por pendentes no cliente. `pendentes:true` filtra a contagem
  // (e exclui a linha "Sem empresa"), então não passamos isso na visão geral.
  // date_field+from/to: recomputa os agregados ao vivo só pras notas cujo evento
  // (emissao/arrived/synced/imported) caiu na janela (mesma semântica do /notas).
  // doc_type/direction forçam o recompute ao vivo no tracker (o contador de
  // empresas não tem essas dimensões) — mesmo caminho do filtro de data.
  list: (
    opts: {
      pendentes?: boolean;
      limit?: number;
      q?: string;
      date_field?: DateField;
      from?: string;
      to?: string;
      doc_type?: DocType;
      direction?: Direction;
    } = {},
  ) => {
    const params: Record<string, string | number> = {};
    if (opts.pendentes) params.pendentes = "true";
    if (opts.limit != null) params.limit = opts.limit;
    if (opts.q) params.q = opts.q; // busca parcial por nome, case-insensitive (backend)
    if (opts.doc_type) params.doc_type = opts.doc_type;
    if (opts.direction) params.direction = opts.direction;
    if (opts.from || opts.to) {
      if (opts.date_field) params.date_field = opts.date_field;
      if (opts.from) params.from = opts.from;
      if (opts.to) params.to = opts.to;
    }
    return xmlApi.get<{ items: EmpresaAgg[]; total: number }>("/empresas", { params });
  },
};

// ── Status dos serviços do tracker ───────────────────────────────────────────

export interface PollerPayload {
  poll_checked: number;
  poll_imported: number;
  poll_ignored: number;
  poll_pending: number;
  sweep_found: number;
  sweep_emitted: number;
  sweep_skipped: number;
  batch: number;
  sweep_interval_s: number;
  sweep_window_h: number;
  version?: string;
  // Reconciliação Athenas↔tracker (janela deslizante de 24h, renovada a cada
  // ~30min). Campos ausentes = ciclo ainda não rodou / versão antiga do poller.
  reconcile_at?: string;
  reconcile_window_h?: number;
  reconcile_athenas?: number; // notas importadas pelo Athenas na janela (verdade)
  reconcile_tracker?: number; // dessas, quantas o tracker conhecia
  reconcile_missing?: number; // divergência real (Athenas sim, tracker não)
  reconcile_fixed?: number; // corrigidas pelo self-heal neste ciclo
  reconcile_accuracy_pct?: number; // 100*(athenas-missing)/athenas (int ou float)
  reconcile_missing_sample?: string[]; // até 5 chaves faltantes (só quando missing>0)
  reconcile_error?: string; // só quando o último ciclo falhou
}

export interface AgentPayload {
  agent_name: string;
  scan_type: string;
  escaneados: number;
  novos: number;
  emitidos: number;
  sem_chave: number;
  version?: string;
}

// Payload do heartbeat do syncer (shadow-sync F1). "modo" é a info de
// segurança nº1 do piloto: dry-run (só planeja, nenhuma escrita) vs real. As
// chaves skip_* variam (uma por motivo/classe de skip) — capturadas pelo
// index signature e agregadas na UI.
export interface SyncerPayload {
  agent_name: string;
  version?: string;
  modo: "dry-run" | "real";
  escaneados: number;
  planejados: number;
  executados: number;
  erros: number;
  error?: string;
  [key: string]: unknown;
}

// Union discriminada por "service" — garante tipagem correta ao acessar payload.
export type ServiceStatus =
  | { service: "poller"; last_beat: string; seconds_ago: number; online: boolean; payload: PollerPayload }
  | { service: "agent"; last_beat: string; seconds_ago: number; online: boolean; payload: AgentPayload }
  | { service: "syncer"; last_beat: string; seconds_ago: number; online: boolean; payload: SyncerPayload }
  | { service: string; last_beat: string; seconds_ago: number; online: boolean; payload: Record<string, unknown> };

export interface SystemStatus {
  services: ServiceStatus[];
}

export const xmlStatusApi = {
  get: () => xmlApi.get<SystemStatus>("/status"),
};

function cleanParams(f: NotaListFilter): Record<string, string | number> {
  const out: Record<string, string | number> = {};
  for (const [k, v] of Object.entries(f)) {
    if (v !== undefined && v !== "" && v !== null) out[k] = v as string | number;
  }
  return out;
}

// ── Labels / estilos de status (pt-BR) ───────────────────────────────────────

export const XML_STATUS_LABEL: Record<NotaStatus, string> = {
  arrived: "A Sincronizar",
  synced: "Sincronizada",
  imported: "Importada",
  import_ignored: "Ignorada",
  pending_import: "Aguardando Importação",
};

export const XML_STATUS_STYLE: Record<NotaStatus, string> = {
  arrived: "bg-yellow-100 text-yellow-800 dark:bg-yellow-900/40 dark:text-yellow-300",
  synced: "bg-sky-100 text-sky-800 dark:bg-sky-900/40 dark:text-sky-300",
  imported: "bg-rps-olive-soft text-rps-olive-dark",
  import_ignored: "bg-gray-200 text-gray-700 dark:bg-gray-800 dark:text-gray-400",
  pending_import: "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300",
};

export const XML_DOC_TYPE_LABEL: Record<DocType, string> = {
  NFE: "NF-e",
  NFCE: "NFC-e",
  CTE: "CT-e",
  NFS: "NFS-e",
  EVENTO: "Evento",
  UNKNOWN: "—",
};
