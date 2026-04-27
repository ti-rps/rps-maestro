"use client";

import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { automationsApi, type Automation } from "@/lib/api";
import { formatDistanceToNow } from "date-fns";
import { ptBR } from "date-fns/locale";

type FormData = {
  name: string;
  description: string;
  scriptPath: string;
  queueName: string;
};

const empty: FormData = { name: "", description: "", scriptPath: "", queueName: "automation_jobs" };

function Modal({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="w-full max-w-md rounded-lg bg-white p-6 shadow-xl">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-semibold">{title}</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-700 text-xl leading-none">
            ×
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

function AutomationForm({
  initial,
  onSubmit,
  loading,
}: {
  initial: FormData;
  onSubmit: (d: FormData) => void;
  loading: boolean;
}) {
  const [form, setForm] = useState(initial);
  const set = (k: keyof FormData) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit(form);
      }}
      className="space-y-3"
    >
      {(["name", "scriptPath", "queueName"] as const).map((k) => (
        <div key={k}>
          <label className="block text-xs font-medium text-gray-600 mb-1 capitalize">
            {k === "scriptPath" ? "Caminho do script" : k === "queueName" ? "Fila" : "Nome"}
          </label>
          <input
            required
            value={form[k]}
            onChange={set(k)}
            className="w-full rounded border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </div>
      ))}
      <div>
        <label className="block text-xs font-medium text-gray-600 mb-1">Descrição</label>
        <textarea
          value={form.description}
          onChange={set("description")}
          rows={2}
          className="w-full rounded border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
        />
      </div>
      <button
        type="submit"
        disabled={loading}
        className="w-full rounded bg-blue-600 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
      >
        {loading ? "Salvando…" : "Salvar"}
      </button>
    </form>
  );
}

export default function AutomationsPage() {
  const qc = useQueryClient();
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<Automation | null>(null);
  const [executing, setExecuting] = useState<Automation | null>(null);
  const [execResult, setExecResult] = useState<string | null>(null);

  const { data: automations, isLoading } = useQuery({
    queryKey: ["automations"],
    queryFn: () => automationsApi.list().then((r) => r.data),
  });

  const create = useMutation({
    mutationFn: (d: FormData) =>
      automationsApi.create({ ...d, description: d.description || undefined }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["automations"] });
      setCreating(false);
    },
  });

  const update = useMutation({
    mutationFn: (d: FormData) =>
      automationsApi.update(editing!.id, { ...d, description: d.description || undefined }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["automations"] });
      setEditing(null);
    },
  });

  const remove = useMutation({
    mutationFn: (id: number) => automationsApi.delete(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["automations"] }),
  });

  const execute = useMutation({
    mutationFn: (id: number) => automationsApi.execute(id),
    onSuccess: (res) => {
      setExecResult(`Job criado: ${res.data.id}`);
      qc.invalidateQueries({ queryKey: ["automations"] });
    },
    onError: (e: unknown) => {
      const msg = e instanceof Error ? e.message : "Erro desconhecido";
      setExecResult(`Erro: ${msg}`);
    },
  });

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Automações</h1>
        <button
          onClick={() => setCreating(true)}
          className="rounded bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
        >
          + Nova automação
        </button>
      </div>

      {isLoading && <p className="text-sm text-gray-400">Carregando…</p>}

      <div className="rounded-lg border border-gray-200 bg-white shadow-sm overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-gray-50">
            <tr className="text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
              <th className="px-4 py-3">Nome</th>
              <th className="px-4 py-3">Script</th>
              <th className="px-4 py-3">Fila</th>
              <th className="px-4 py-3">Criada</th>
              <th className="px-4 py-3"></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {automations?.map((a) => (
              <tr key={a.id} className="hover:bg-gray-50">
                <td className="px-4 py-3 font-medium text-gray-900">{a.name}</td>
                <td className="px-4 py-3 text-gray-500 font-mono text-xs">{a.scriptPath}</td>
                <td className="px-4 py-3 text-gray-500">{a.queueName}</td>
                <td className="px-4 py-3 text-gray-400">
                  {formatDistanceToNow(new Date(a.createdAt), { locale: ptBR, addSuffix: true })}
                </td>
                <td className="px-4 py-3">
                  <div className="flex gap-2 justify-end">
                    <button
                      onClick={() => {
                        setExecuting(a);
                        setExecResult(null);
                      }}
                      className="rounded bg-green-100 px-2 py-1 text-xs font-medium text-green-700 hover:bg-green-200"
                    >
                      Executar
                    </button>
                    <button
                      onClick={() => setEditing(a)}
                      className="rounded bg-gray-100 px-2 py-1 text-xs font-medium text-gray-700 hover:bg-gray-200"
                    >
                      Editar
                    </button>
                    <button
                      onClick={() => {
                        if (confirm("Remover esta automação?")) remove.mutate(a.id);
                      }}
                      className="rounded bg-red-100 px-2 py-1 text-xs font-medium text-red-700 hover:bg-red-200"
                    >
                      Remover
                    </button>
                  </div>
                </td>
              </tr>
            ))}
            {automations?.length === 0 && (
              <tr>
                <td colSpan={5} className="px-4 py-6 text-center text-gray-400 text-sm">
                  Nenhuma automação cadastrada.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {creating && (
        <Modal title="Nova automação" onClose={() => setCreating(false)}>
          <AutomationForm initial={empty} onSubmit={(d) => create.mutate(d)} loading={create.isPending} />
        </Modal>
      )}

      {editing && (
        <Modal title="Editar automação" onClose={() => setEditing(null)}>
          <AutomationForm
            initial={{
              name: editing.name,
              description: editing.description ?? "",
              scriptPath: editing.scriptPath,
              queueName: editing.queueName,
            }}
            onSubmit={(d) => update.mutate(d)}
            loading={update.isPending}
          />
        </Modal>
      )}

      {executing && (
        <Modal title={`Executar: ${executing.name}`} onClose={() => setExecuting(null)}>
          <p className="text-sm text-gray-600 mb-4">
            Isso criará um job imediato na fila <strong>{executing.queueName}</strong>.
          </p>
          {execResult && (
            <p className={`mb-3 text-sm ${execResult.startsWith("Erro") ? "text-red-600" : "text-green-600"}`}>
              {execResult}
            </p>
          )}
          <button
            onClick={() => execute.mutate(executing.id)}
            disabled={execute.isPending}
            className="w-full rounded bg-green-600 py-2 text-sm font-medium text-white hover:bg-green-700 disabled:opacity-50"
          >
            {execute.isPending ? "Enviando…" : "Confirmar execução"}
          </button>
        </Modal>
      )}
    </div>
  );
}
