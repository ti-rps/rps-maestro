"use client";

import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { schedulesApi, automationsApi, type Schedule } from "@/lib/api";
import { formatDistanceToNow } from "date-fns";
import { ptBR } from "date-fns/locale";

type FormData = {
  automationId: number;
  cronExpression: string;
  isEnabled: boolean;
};

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

const CRON_PRESETS = [
  { label: "A cada hora", value: "0 * * * *" },
  { label: "Todo dia às 08h", value: "0 8 * * *" },
  { label: "Toda segunda às 09h", value: "0 9 * * 1" },
  { label: "Primeira do mês", value: "0 0 1 * *" },
];

function ScheduleForm({
  initial,
  automations,
  onSubmit,
  loading,
}: {
  initial: FormData;
  automations: { id: number; name: string }[];
  onSubmit: (d: FormData) => void;
  loading: boolean;
}) {
  const [form, setForm] = useState(initial);

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit(form);
      }}
      className="space-y-3"
    >
      <div>
        <label className="block text-xs font-medium text-gray-600 mb-1">Automação</label>
        <select
          required
          value={form.automationId}
          onChange={(e) => setForm((f) => ({ ...f, automationId: Number(e.target.value) }))}
          className="w-full rounded border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
        >
          <option value={0} disabled>
            Selecione…
          </option>
          {automations.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </select>
      </div>

      <div>
        <label className="block text-xs font-medium text-gray-600 mb-1">Expressão Cron</label>
        <input
          required
          value={form.cronExpression}
          onChange={(e) => setForm((f) => ({ ...f, cronExpression: e.target.value }))}
          placeholder="0 8 * * *"
          className="w-full rounded border border-gray-300 px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-blue-500"
        />
        <div className="mt-1 flex flex-wrap gap-1">
          {CRON_PRESETS.map((p) => (
            <button
              type="button"
              key={p.value}
              onClick={() => setForm((f) => ({ ...f, cronExpression: p.value }))}
              className="rounded bg-gray-100 px-2 py-0.5 text-xs text-gray-600 hover:bg-gray-200"
            >
              {p.label}
            </button>
          ))}
        </div>
      </div>

      <div className="flex items-center gap-2">
        <input
          type="checkbox"
          id="enabled"
          checked={form.isEnabled}
          onChange={(e) => setForm((f) => ({ ...f, isEnabled: e.target.checked }))}
          className="rounded border-gray-300"
        />
        <label htmlFor="enabled" className="text-sm text-gray-700">
          Ativo
        </label>
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

export default function SchedulesPage() {
  const qc = useQueryClient();
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<Schedule | null>(null);

  const { data: schedules, isLoading } = useQuery({
    queryKey: ["schedules"],
    queryFn: () => schedulesApi.list().then((r) => r.data),
  });

  const { data: automations } = useQuery({
    queryKey: ["automations"],
    queryFn: () => automationsApi.list().then((r) => r.data),
  });

  const create = useMutation({
    mutationFn: (d: FormData) => schedulesApi.create(d),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["schedules"] });
      setCreating(false);
    },
  });

  const update = useMutation({
    mutationFn: (d: FormData) => schedulesApi.update(editing!.id, d),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["schedules"] });
      setEditing(null);
    },
  });

  const remove = useMutation({
    mutationFn: (id: number) => schedulesApi.delete(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["schedules"] }),
  });

  const toggle = useMutation({
    mutationFn: (s: Schedule) => schedulesApi.update(s.id, { isEnabled: !s.isEnabled }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["schedules"] }),
  });

  const autoList = automations ?? [];

  const getAutoName = (id: number) => autoList.find((a) => a.id === id)?.name ?? `#${id}`;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Agendamentos</h1>
        <button
          onClick={() => setCreating(true)}
          className="rounded bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
        >
          + Novo agendamento
        </button>
      </div>

      {isLoading && <p className="text-sm text-gray-400">Carregando…</p>}

      <div className="rounded-lg border border-gray-200 bg-white shadow-sm overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-gray-50">
            <tr className="text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
              <th className="px-4 py-3">Automação</th>
              <th className="px-4 py-3">Cron</th>
              <th className="px-4 py-3">Próxima execução</th>
              <th className="px-4 py-3">Status</th>
              <th className="px-4 py-3"></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {schedules?.map((s) => (
              <tr key={s.id} className="hover:bg-gray-50">
                <td className="px-4 py-3 font-medium text-gray-900">{getAutoName(s.automationId)}</td>
                <td className="px-4 py-3 font-mono text-xs text-gray-500">{s.cronExpression}</td>
                <td className="px-4 py-3 text-gray-400">
                  {s.nextRunAt
                    ? formatDistanceToNow(new Date(s.nextRunAt), { locale: ptBR, addSuffix: true })
                    : "—"}
                </td>
                <td className="px-4 py-3">
                  <button
                    onClick={() => toggle.mutate(s)}
                    className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                      s.isEnabled
                        ? "bg-green-100 text-green-700 hover:bg-green-200"
                        : "bg-gray-100 text-gray-500 hover:bg-gray-200"
                    }`}
                  >
                    {s.isEnabled ? "Ativo" : "Inativo"}
                  </button>
                </td>
                <td className="px-4 py-3">
                  <div className="flex gap-2 justify-end">
                    <button
                      onClick={() => setEditing(s)}
                      className="rounded bg-gray-100 px-2 py-1 text-xs font-medium text-gray-700 hover:bg-gray-200"
                    >
                      Editar
                    </button>
                    <button
                      onClick={() => {
                        if (confirm("Remover este agendamento?")) remove.mutate(s.id);
                      }}
                      className="rounded bg-red-100 px-2 py-1 text-xs font-medium text-red-700 hover:bg-red-200"
                    >
                      Remover
                    </button>
                  </div>
                </td>
              </tr>
            ))}
            {schedules?.length === 0 && (
              <tr>
                <td colSpan={5} className="px-4 py-6 text-center text-gray-400 text-sm">
                  Nenhum agendamento cadastrado.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {creating && (
        <Modal title="Novo agendamento" onClose={() => setCreating(false)}>
          <ScheduleForm
            initial={{ automationId: 0, cronExpression: "", isEnabled: true }}
            automations={autoList}
            onSubmit={(d) => create.mutate(d)}
            loading={create.isPending}
          />
        </Modal>
      )}

      {editing && (
        <Modal title="Editar agendamento" onClose={() => setEditing(null)}>
          <ScheduleForm
            initial={{
              automationId: editing.automationId,
              cronExpression: editing.cronExpression,
              isEnabled: editing.isEnabled,
            }}
            automations={autoList}
            onSubmit={(d) => update.mutate(d)}
            loading={update.isPending}
          />
        </Modal>
      )}
    </div>
  );
}
