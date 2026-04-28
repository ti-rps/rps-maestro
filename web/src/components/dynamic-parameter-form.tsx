"use client";

import { useState } from "react";
import type { ParameterField, ParameterSchema } from "@/lib/api";

type Values = Record<string, string | number>;

function coerce(field: ParameterField, raw: string): string | number {
  if (field.type === "number" && raw !== "") {
    const n = Number(raw);
    return Number.isNaN(n) ? raw : n;
  }
  return raw;
}

export function DynamicParameterForm({
  schema,
  initial,
  submitLabel,
  onSubmit,
  loading,
}: {
  schema: ParameterSchema;
  initial?: Record<string, unknown>;
  submitLabel: string;
  onSubmit: (values: Record<string, unknown>) => void;
  loading?: boolean;
}) {
  const [values, setValues] = useState<Values>(() => {
    const v: Values = {};
    for (const f of schema) {
      const init = initial?.[f.name];
      v[f.name] = init === undefined || init === null ? "" : String(init);
    }
    return v;
  });

  const set = (name: string, raw: string) => setValues((v) => ({ ...v, [name]: raw }));

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const out: Record<string, unknown> = {};
    for (const f of schema) {
      const raw = values[f.name];
      if (raw === "" || raw === undefined) continue;
      out[f.name] = coerce(f, String(raw));
    }
    onSubmit(out);
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-3">
      {schema.length === 0 && (
        <p className="text-sm text-gray-500">Nenhum parâmetro definido para esta automação.</p>
      )}

      {schema.map((f) => (
        <div key={f.name}>
          <label className="block text-xs font-medium text-gray-600 mb-1">
            {f.label}
            {f.required && <span className="text-red-500 ml-0.5">*</span>}
          </label>
          {f.type === "select" ? (
            <select
              required={f.required}
              value={String(values[f.name] ?? "")}
              onChange={(e) => set(f.name, e.target.value)}
              className="w-full rounded border border-gray-300 px-3 py-2 text-sm"
            >
              <option value="">Selecione…</option>
              {(f.options ?? []).map((o) => (
                <option key={o} value={o}>
                  {o}
                </option>
              ))}
            </select>
          ) : (
            <input
              required={f.required}
              type={f.type === "date" ? "date" : f.type === "number" ? "number" : "text"}
              placeholder={f.placeholder}
              value={String(values[f.name] ?? "")}
              onChange={(e) => set(f.name, e.target.value)}
              className="w-full rounded border border-gray-300 px-3 py-2 text-sm"
            />
          )}
        </div>
      ))}

      <button
        type="submit"
        disabled={loading}
        className="w-full rounded bg-green-600 py-2 text-sm font-medium text-white hover:bg-green-700 disabled:opacity-50"
      >
        {loading ? "Enviando…" : submitLabel}
      </button>
    </form>
  );
}
