"use client";

import { useQuery } from "@tanstack/react-query";
import { automationsApi, schedulesApi } from "@/lib/api";
import { formatDistanceToNow } from "date-fns";
import { ptBR } from "date-fns/locale";

function StatCard({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="rounded-lg border border-gray-200 bg-white p-5 shadow-sm">
      <p className="text-sm text-gray-500">{label}</p>
      <p className="mt-1 text-3xl font-bold text-gray-900">{value}</p>
    </div>
  );
}

export default function DashboardPage() {
  const { data: automations } = useQuery({
    queryKey: ["automations"],
    queryFn: () => automationsApi.list().then((r) => r.data),
  });

  const { data: schedules } = useQuery({
    queryKey: ["schedules"],
    queryFn: () => schedulesApi.list().then((r) => r.data),
  });

  const enabledSchedules = schedules?.filter((s) => s.isEnabled).length ?? 0;

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">Dashboard</h1>

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatCard label="Automações" value={automations?.length ?? "—"} />
        <StatCard label="Agendamentos ativos" value={enabledSchedules} />
        <StatCard label="Jobs hoje" value="—" />
        <StatCard label="Taxa de sucesso" value="—" />
      </div>

      <div className="rounded-lg border border-gray-200 bg-white p-5 shadow-sm">
        <h2 className="mb-4 text-sm font-semibold text-gray-700">Automações cadastradas</h2>
        {!automations || automations.length === 0 ? (
          <p className="text-sm text-gray-400">Nenhuma automação cadastrada.</p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-100 text-left text-gray-500">
                <th className="pb-2 font-medium">Nome</th>
                <th className="pb-2 font-medium">Fila</th>
                <th className="pb-2 font-medium">Criada em</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-50">
              {automations.map((a) => (
                <tr key={a.id}>
                  <td className="py-2 font-medium text-gray-900">{a.name}</td>
                  <td className="py-2 text-gray-500">{a.queueName}</td>
                  <td className="py-2 text-gray-400">
                    {formatDistanceToNow(new Date(a.createdAt), {
                      locale: ptBR,
                      addSuffix: true,
                    })}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
