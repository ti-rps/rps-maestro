"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { jobsApi, type Job, type JobLog } from "@/lib/api";
import { formatDistanceToNow, format } from "date-fns";
import { ptBR } from "date-fns/locale";

const STATUS_STYLE: Record<string, string> = {
  pending: "bg-yellow-100 text-yellow-800",
  running: "bg-blue-100 text-blue-800",
  completed: "bg-green-100 text-green-800",
  failed: "bg-red-100 text-red-800",
};

const STATUS_LABEL: Record<string, string> = {
  pending: "Pendente",
  running: "Executando",
  completed: "Concluído",
  failed: "Falhou",
};

const LOG_COLOR: Record<string, string> = {
  error: "text-red-400",
  warn: "text-yellow-400",
  info: "text-gray-300",
  debug: "text-gray-500",
};

function JobPanel({ jobId, onClose }: { jobId: string; onClose: () => void }) {
  const { data: job } = useQuery({
    queryKey: ["jobs", jobId],
    queryFn: () => jobsApi.get(jobId).then((r) => r.data),
    refetchInterval: (q) =>
      q.state.data?.status === "running" || q.state.data?.status === "pending" ? 3000 : false,
  });

  const { data: logs } = useQuery({
    queryKey: ["jobs", jobId, "logs"],
    queryFn: () => jobsApi.logs(jobId).then((r) => r.data),
    refetchInterval: (q) => {
      return job?.status === "running" || job?.status === "pending" ? 3000 : false;
    },
  });

  return (
    <div className="fixed inset-y-0 right-0 z-50 w-[480px] bg-white shadow-2xl flex flex-col border-l border-gray-200">
      <div className="flex items-center justify-between px-4 py-3 border-b border-gray-200">
        <div>
          <p className="text-sm font-semibold text-gray-900">Job</p>
          <p className="text-xs font-mono text-gray-400">{jobId}</p>
        </div>
        <button onClick={onClose} className="text-gray-400 hover:text-gray-700 text-xl leading-none">
          ×
        </button>
      </div>

      {job && (
        <div className="px-4 py-3 border-b border-gray-100 flex gap-3 text-sm">
          <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_STYLE[job.status]}`}>
            {STATUS_LABEL[job.status]}
          </span>
          {job.startedAt && (
            <span className="text-gray-400">
              Iniciado {formatDistanceToNow(new Date(job.startedAt), { locale: ptBR, addSuffix: true })}
            </span>
          )}
        </div>
      )}

      <div className="flex-1 overflow-auto bg-gray-900 p-4 font-mono text-xs">
        {!logs || logs.length === 0 ? (
          <p className="text-gray-500">Nenhum log disponível.</p>
        ) : (
          logs.map((l) => (
            <div key={l.id} className="flex gap-2 mb-1">
              <span className="text-gray-600 shrink-0">
                {format(new Date(l.timestamp), "HH:mm:ss")}
              </span>
              <span className={`uppercase shrink-0 w-8 ${LOG_COLOR[l.level] ?? "text-gray-300"}`}>
                {l.level.slice(0, 4)}
              </span>
              <span className={LOG_COLOR[l.level] ?? "text-gray-300"}>{l.message}</span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

const SAMPLE_JOB_IDS: string[] = [];

export default function JobsPage() {
  const [filter, setFilter] = useState<string>("all");
  const [selectedJobId, setSelectedJobId] = useState<string | null>(null);
  const [jobIdInput, setJobIdInput] = useState("");
  const [searchedJobs, setSearchedJobs] = useState<Job[]>([]);

  const handleSearch = async () => {
    if (!jobIdInput.trim()) return;
    try {
      const res = await jobsApi.get(jobIdInput.trim());
      setSearchedJobs((prev) => {
        const exists = prev.find((j) => j.id === res.data.id);
        return exists ? prev : [res.data, ...prev];
      });
    } catch {
      alert("Job não encontrado.");
    }
  };

  const filtered = filter === "all" ? searchedJobs : searchedJobs.filter((j) => j.status === filter);

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold">Jobs</h1>

      <div className="flex gap-2">
        <input
          value={jobIdInput}
          onChange={(e) => setJobIdInput(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && handleSearch()}
          placeholder="Buscar por Job ID (UUID)…"
          className="flex-1 rounded border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
        />
        <button
          onClick={handleSearch}
          className="rounded bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
        >
          Buscar
        </button>
      </div>

      <div className="flex gap-2">
        {["all", "pending", "running", "completed", "failed"].map((s) => (
          <button
            key={s}
            onClick={() => setFilter(s)}
            className={`rounded-full px-3 py-1 text-xs font-medium transition-colors ${
              filter === s ? "bg-blue-600 text-white" : "bg-gray-100 text-gray-700 hover:bg-gray-200"
            }`}
          >
            {s === "all" ? "Todos" : STATUS_LABEL[s]}
          </button>
        ))}
      </div>

      <div className="rounded-lg border border-gray-200 bg-white shadow-sm overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-gray-50">
            <tr className="text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
              <th className="px-4 py-3">ID</th>
              <th className="px-4 py-3">Automação</th>
              <th className="px-4 py-3">Status</th>
              <th className="px-4 py-3">Criado</th>
              <th className="px-4 py-3"></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {filtered.map((j) => (
              <tr key={j.id} className="hover:bg-gray-50">
                <td className="px-4 py-3 font-mono text-xs text-gray-500">{j.id.slice(0, 8)}…</td>
                <td className="px-4 py-3 text-gray-700">{j.automationId}</td>
                <td className="px-4 py-3">
                  <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_STYLE[j.status]}`}>
                    {STATUS_LABEL[j.status]}
                  </span>
                </td>
                <td className="px-4 py-3 text-gray-400">
                  {formatDistanceToNow(new Date(j.createdAt), { locale: ptBR, addSuffix: true })}
                </td>
                <td className="px-4 py-3">
                  <button
                    onClick={() => setSelectedJobId(j.id)}
                    className="rounded bg-gray-100 px-2 py-1 text-xs font-medium text-gray-700 hover:bg-gray-200"
                  >
                    Ver logs
                  </button>
                </td>
              </tr>
            ))}
            {filtered.length === 0 && (
              <tr>
                <td colSpan={5} className="px-4 py-8 text-center text-gray-400 text-sm">
                  Busque um job pelo ID para visualizar detalhes e logs.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {selectedJobId && (
        <JobPanel jobId={selectedJobId} onClose={() => setSelectedJobId(null)} />
      )}
    </div>
  );
}
