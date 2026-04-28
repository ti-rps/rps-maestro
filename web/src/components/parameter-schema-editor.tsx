"use client";

import type { ParameterField, ParameterFieldType, ParameterSchema } from "@/lib/api";

const TYPE_OPTIONS: { value: ParameterFieldType; label: string }[] = [
  { value: "text", label: "Texto" },
  { value: "number", label: "Número" },
  { value: "date", label: "Data" },
  { value: "select", label: "Seleção" },
];

export function ParameterSchemaEditor({
  value,
  onChange,
}: {
  value: ParameterSchema;
  onChange: (next: ParameterSchema) => void;
}) {
  const update = (idx: number, patch: Partial<ParameterField>) => {
    onChange(value.map((f, i) => (i === idx ? { ...f, ...patch } : f)));
  };

  const remove = (idx: number) => onChange(value.filter((_, i) => i !== idx));

  const add = () =>
    onChange([
      ...value,
      { name: "", label: "", type: "text", required: false } as ParameterField,
    ]);

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <label className="text-xs font-medium text-gray-600">Schema de parâmetros</label>
        <button
          type="button"
          onClick={add}
          className="rounded bg-gray-100 px-2 py-1 text-xs text-gray-700 hover:bg-gray-200"
        >
          + Adicionar campo
        </button>
      </div>

      {value.length === 0 && (
        <p className="text-xs text-gray-400">
          Nenhum campo. Adicione campos que o worker espera (ex.: stores, start_date).
        </p>
      )}

      {value.map((f, idx) => (
        <div key={idx} className="rounded border border-gray-200 p-2 space-y-2 bg-gray-50">
          <div className="grid grid-cols-2 gap-2">
            <input
              required
              placeholder="name (ex: stores)"
              value={f.name}
              onChange={(e) => update(idx, { name: e.target.value })}
              className="rounded border border-gray-300 px-2 py-1 text-xs font-mono"
            />
            <input
              required
              placeholder="Label (ex: Lojas)"
              value={f.label}
              onChange={(e) => update(idx, { label: e.target.value })}
              className="rounded border border-gray-300 px-2 py-1 text-xs"
            />
          </div>
          <div className="grid grid-cols-3 gap-2 items-center">
            <select
              value={f.type}
              onChange={(e) => update(idx, { type: e.target.value as ParameterFieldType })}
              className="rounded border border-gray-300 px-2 py-1 text-xs"
            >
              {TYPE_OPTIONS.map((t) => (
                <option key={t.value} value={t.value}>
                  {t.label}
                </option>
              ))}
            </select>
            <label className="flex items-center gap-1 text-xs text-gray-700">
              <input
                type="checkbox"
                checked={!!f.required}
                onChange={(e) => update(idx, { required: e.target.checked })}
              />
              Obrigatório
            </label>
            <button
              type="button"
              onClick={() => remove(idx)}
              className="rounded bg-red-100 px-2 py-1 text-xs text-red-700 hover:bg-red-200"
            >
              Remover
            </button>
          </div>
          {f.type === "select" && (
            <input
              placeholder="Opções separadas por vírgula"
              value={(f.options ?? []).join(", ")}
              onChange={(e) =>
                update(idx, {
                  options: e.target.value
                    .split(",")
                    .map((s) => s.trim())
                    .filter(Boolean),
                })
              }
              className="w-full rounded border border-gray-300 px-2 py-1 text-xs"
            />
          )}
          <input
            placeholder="Placeholder (opcional)"
            value={f.placeholder ?? ""}
            onChange={(e) => update(idx, { placeholder: e.target.value || undefined })}
            className="w-full rounded border border-gray-300 px-2 py-1 text-xs"
          />
        </div>
      ))}
    </div>
  );
}
