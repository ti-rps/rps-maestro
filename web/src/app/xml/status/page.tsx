"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { Bot, User, AlertTriangle, Info, ArrowLeft } from "lucide-react";
import {
  xmlStatusApi,
  type PollerPayload,
  type AgentPayload,
  type SyncerPayload,
  type ServiceStatus,
} from "@/lib/xml-api";
import { Skeleton } from "@/components/skeleton";

// ── helpers ──────────────────────────────────────────────────────────────────

function fmtAgo(secs: number): string {
  if (secs < 60) return `há ${secs}s`;
  if (secs < 3600) return `há ${Math.floor(secs / 60)}min`;
  return `há ${Math.floor(secs / 3600)}h`;
}

function fmtNum(n: number): string {
  return new Intl.NumberFormat("pt-BR").format(n);
}

// Separa os serviços conhecidos (typed) dos demais.
function findService<T extends "poller" | "agent" | "syncer">(
  services: ServiceStatus[],
  name: T,
): Extract<ServiceStatus, { service: T }> | undefined {
  return services.find((s) => s.service === name) as
    | Extract<ServiceStatus, { service: T }>
    | undefined;
}

// ── sub-components ───────────────────────────────────────────────────────────

function Dot({ online }: { online: boolean | null }) {
  if (online === null)
    return <span className="h-2.5 w-2.5 rounded-full bg-gray-300 dark:bg-gray-600" />;
  return (
    <span
      className={`h-2.5 w-2.5 rounded-full ${online ? "bg-green-500" : "bg-red-500"}`}
    />
  );
}

function ServiceCard({
  name,
  online,
  subtitle,
  icon,
}: {
  name: string;
  online: boolean | null;
  subtitle: string;
  icon: React.ReactNode;
}) {
  return (
    <div className="flex items-start gap-3 rounded-lg border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 p-4 shadow-sm">
      <div className="mt-0.5 shrink-0">{icon}</div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <Dot online={online} />
          <span className="text-sm font-semibold text-gray-900 dark:text-gray-100">{name}</span>
        </div>
        <p className="mt-0.5 text-xs text-gray-500">{subtitle}</p>
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 p-4 shadow-sm">
      <h3 className="mb-3 text-sm font-semibold text-gray-700 dark:text-gray-300">{title}</h3>
      {children}
    </div>
  );
}

function Row({ label, value, zero = false }: { label: string; value: number | string; zero?: boolean }) {
  const num = typeof value === "number" ? value : null;
  const display = typeof value === "number" ? fmtNum(value) : value;
  const dimmed = num === 0 && zero;
  return (
    <div className="flex items-baseline justify-between gap-4 py-1">
      <span className="text-sm text-gray-600 dark:text-gray-400">{label}</span>
      <span
        className={`tabular-nums text-sm font-medium ${
          dimmed ? "text-gray-300 dark:text-gray-600" : "text-gray-900 dark:text-gray-100"
        }`}
      >
        {display}
      </span>
    </div>
  );
}

function Divider() {
  return <div className="my-2 border-t border-gray-100 dark:border-gray-800" />;
}

// ── alertas ──────────────────────────────────────────────────────────────────

interface Alert {
  level: "red" | "yellow" | "green";
  text: string;
  key: string;
}

function buildAlerts(
  services: ServiceStatus[],
  apiOnline: boolean,
  sweepDismissed: boolean,
): Alert[] {
  const alerts: Alert[] = [];
  const poller = findService(services, "poller");
  const agent = findService(services, "agent");

  if (!apiOnline) {
    alerts.push({ level: "red", key: "api", text: "API offline — não foi possível obter o status dos serviços" });
  }
  if (!poller) {
    alerts.push({ level: "yellow", key: "poller-missing", text: "Poller ainda não enviou heartbeat — aguardando primeira conexão" });
  } else if (!poller.online) {
    alerts.push({ level: "red", key: "poller-offline", text: "Poller offline — importações podem atrasar" });
  } else {
    const p = poller.payload;
    if (p.poll_imported === 0 && p.poll_checked > 0 && poller.seconds_ago > 1800) {
      alerts.push({ level: "yellow", key: "no-import", text: "Nenhuma importação detectada no último ciclo" });
    }
    if (p.sweep_emitted > 0 && !sweepDismissed) {
      alerts.push({ level: "green", key: "sweep", text: `Sweep detectou ${fmtNum(p.sweep_emitted)} nota${p.sweep_emitted === 1 ? "" : "s"} importada${p.sweep_emitted === 1 ? "" : "s"} recentemente` });
    }
  }
  if (!agent) {
    alerts.push({ level: "yellow", key: "agent-missing", text: "Agente ainda não enviou heartbeat — aguardando primeira conexão" });
  } else if (!agent.online) {
    alerts.push({ level: "red", key: "agent-offline", text: "Agente offline — novas notas não serão detectadas" });
  }
  return alerts;
}

const ALERT_CLS: Record<Alert["level"], string> = {
  red: "border-red-200 bg-red-50 text-red-800 dark:border-red-900/50 dark:bg-red-950/30 dark:text-red-300",
  yellow: "border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-900/50 dark:bg-amber-950/30 dark:text-amber-300",
  green: "border-green-200 bg-green-50 text-green-800 dark:border-green-900/50 dark:bg-green-950/30 dark:text-green-300",
};

const ALERT_ICON: Record<Alert["level"], React.ReactNode> = {
  red: <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden />,
  yellow: <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden />,
  green: <Info className="h-4 w-4 shrink-0" aria-hidden />,
};

// ── página ───────────────────────────────────────────────────────────────────

export default function XmlStatusPage() {
  const [sweepDismissed, setSweepDismissed] = useState(false);
  // `now` atualizado pelo intervalo — evita chamar Date.now() diretamente no
  // render (react-hooks/purity proíbe funções impuras em render).
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 5000);
    return () => clearInterval(id);
  }, []);

  const { data, isLoading, isError, dataUpdatedAt, isFetching } = useQuery({
    queryKey: ["xml", "system-status"],
    queryFn: () => xmlStatusApi.get().then((r) => r.data),
    refetchInterval: 15_000,
    retry: 1,
  });

  const services = data?.services ?? [];
  const apiOnline = !isError;
  const poller = findService(services, "poller");
  const agent = findService(services, "agent");
  const syncer = findService(services, "syncer");
  const alerts = buildAlerts(services, apiOnline, sweepDismissed);

  // Auto-dismiss do alerta verde (sweep) após 60s.
  // Usamos um ref pra marcar a primeira vez que sweep > 0 foi detectado, sem
  // chamar setState dentro do effect (proibido pela lint).
  const sweepTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hasSweep = !!(poller && (poller.payload as PollerPayload).sweep_emitted > 0);
  useEffect(() => {
    if (hasSweep && !sweepDismissed && !sweepTimerRef.current) {
      sweepTimerRef.current = setTimeout(() => setSweepDismissed(true), 60_000);
    }
    return () => {
      if (!hasSweep && sweepTimerRef.current) {
        clearTimeout(sweepTimerRef.current);
        sweepTimerRef.current = null;
      }
    };
  }, [hasSweep, sweepDismissed]);

  // Subtextos dos cards
  function apiSubtitle() {
    if (isLoading) return "Verificando…";
    if (isError) return "Offline · falha na conexão";
    return `Online · ${fmtAgo(Math.round((now - dataUpdatedAt) / 1000))}`;
  }
  function svcSubtitle(svc?: ServiceStatus) {
    if (!svc) return "Aguardando primeiro sinal…";
    // Versão vem no payload (poller/agent) — mostra discreto quando presente.
    const version = (svc.payload as { version?: string })?.version;
    const ver = version ? ` · v${version}` : "";
    if (!svc.online) return `Offline · último sinal ${fmtAgo(svc.seconds_ago)}${ver}`;
    return `Online · ${fmtAgo(svc.seconds_ago)}${ver}`;
  }

  return (
    <div className="space-y-5">
      <Link
        href="/xml"
        className="inline-flex items-center gap-1.5 text-sm text-gray-500 hover:text-rps-olive-dark transition-colors"
      >
        <ArrowLeft className="h-4 w-4" aria-hidden />
        Voltar ao Rastreador XML
      </Link>
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
          Status do Sistema — Rastreador XML
        </h1>
        <span className="text-xs text-gray-500">
          {isFetching ? "Atualizando…" : "Atualiza a cada 15s"}
        </span>
      </div>

      {/* Alertas */}
      {alerts.length > 0 && (
        <div className="space-y-2">
          {alerts.map((a) => (
            <div
              key={a.key}
              className={`flex items-center gap-2 rounded-lg border px-4 py-2.5 text-sm ${ALERT_CLS[a.level]}`}
            >
              {ALERT_ICON[a.level]}
              {a.text}
            </div>
          ))}
        </div>
      )}

      {/* Cards de saúde */}
      {isLoading ? (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-20 w-full" />)}
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <ServiceCard
            name="API"
            online={apiOnline ? true : false}
            subtitle={apiSubtitle()}
            icon={<Bot className="h-5 w-5 text-gray-400" aria-hidden />}
          />
          <ServiceCard
            name="Poller"
            online={poller ? poller.online : null}
            subtitle={svcSubtitle(poller)}
            icon={<Bot className="h-5 w-5 text-gray-400" aria-hidden />}
          />
          <ServiceCard
            name="Agente"
            online={agent ? agent.online : null}
            subtitle={svcSubtitle(agent)}
            icon={<User className="h-5 w-5 text-gray-400" aria-hidden />}
          />
          <ServiceCard
            name="Syncer"
            online={syncer ? syncer.online : null}
            subtitle={svcSubtitle(syncer)}
            icon={<Bot className="h-5 w-5 text-gray-400" aria-hidden />}
          />
        </div>
      )}

      {/* Atividade recente */}
      {!isLoading && (
        <div className="grid gap-4 lg:grid-cols-3">
          {/* Poller */}
          <div className="space-y-4">
            {poller ? (
              <>
                <Section title="Poller — Último ciclo">
                  {(() => {
                    const p = poller.payload as PollerPayload;
                    return (
                      <>
                        <Row label="Checadas" value={p.poll_checked} zero />
                        <Row label="Importadas" value={p.poll_imported} zero />
                        <Row label="Pendentes" value={p.poll_pending} zero />
                        <Divider />
                        <p className="text-xs text-gray-400">Lote: {fmtNum(p.batch)} · Ciclo contínuo</p>
                      </>
                    );
                  })()}
                </Section>
                <Section title="Poller — Último sweep">
                  {(() => {
                    const p = poller.payload as PollerPayload;
                    return (
                      <>
                        <Row label="Achadas no Firebird" value={p.sweep_found} zero />
                        <Row label="Novas no tracker" value={p.sweep_emitted} zero />
                        <Row label="Já conhecidas" value={p.sweep_skipped} zero />
                        <Divider />
                        <p className="text-xs text-gray-400">
                          Sweep a cada {p.sweep_interval_s / 60}min · janela {p.sweep_window_h}h
                        </p>
                      </>
                    );
                  })()}
                </Section>
              </>
            ) : (
              <Section title="Poller">
                <p className="py-4 text-center text-sm text-gray-500">Sem dados — aguardando primeiro heartbeat.</p>
              </Section>
            )}
          </div>

          {/* Agente */}
          <div className="space-y-4">
            {agent ? (
              <Section title={`Agente — Último scan · ${(agent.payload as AgentPayload).scan_type}`}>
                {(() => {
                  const p = agent.payload as AgentPayload;
                  return (
                    <>
                      <Row label="Nome do agente" value={p.agent_name} />
                      <Divider />
                      <Row label="Escaneados" value={p.escaneados} zero />
                      <Row label="Novas notas" value={p.novos} zero />
                      <Row label="Emitidas" value={p.emitidos} zero />
                      <Row label="Sem chave (erro de parse)" value={p.sem_chave} zero />
                    </>
                  );
                })()}
              </Section>
            ) : (
              <Section title="Agente">
                <p className="py-4 text-center text-sm text-gray-500">Sem dados — aguardando primeiro heartbeat.</p>
              </Section>
            )}
          </div>

          {/* Syncer */}
          <div className="space-y-4">
            {syncer ? (
              <Section title="Syncer — Piloto shadow-sync">
                {(() => {
                  const p = syncer.payload as SyncerPayload;
                  // "modo" é a informação de segurança nº1 do piloto: dry-run
                  // (só planeja, nenhuma escrita) vs real (grava no Athenas).
                  const isReal = p.modo === "real";
                  const skips = Object.entries(p).filter(
                    ([k, v]) => k.startsWith("skip_") && typeof v === "number",
                  ) as [string, number][];
                  return (
                    <>
                      <p
                        className={`mb-3 inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold ${
                          isReal
                            ? "bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300"
                            : "bg-sky-100 text-sky-800 dark:bg-sky-900/40 dark:text-sky-300"
                        }`}
                      >
                        {isReal ? "MODO REAL — grava no Athenas" : "DRY-RUN — nenhuma escrita"}
                      </p>
                      <Row label="Escaneados" value={p.escaneados} zero />
                      <Row label="Planejados" value={p.planejados} zero />
                      <Row label="Executados" value={p.executados} zero />
                      <Row label="Erros" value={p.erros} zero />
                      {skips.length > 0 && (
                        <>
                          <Divider />
                          <p className="text-xs text-gray-400" title={skips.map(([k, v]) => `${k.replace("skip_", "")}: ${v}`).join(" · ")}>
                            Pulados: {skips.map(([k, v]) => `${k.replace("skip_", "")} (${v})`).join(" · ")}
                          </p>
                        </>
                      )}
                      {p.error && (
                        <p className="mt-2 rounded border border-red-200 bg-red-50 px-2 py-1 text-[11px] text-red-700 dark:border-red-900/40 dark:bg-red-900/20 dark:text-red-400">
                          {p.error}
                        </p>
                      )}
                    </>
                  );
                })()}
              </Section>
            ) : (
              <Section title="Syncer">
                <p className="py-4 text-center text-sm text-gray-500">Sem dados — aguardando primeiro heartbeat.</p>
              </Section>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
