"use client";

import { useState } from "react";
import type { ParameterField, ParameterSchema } from "@/lib/api";

type Values = Record<string, string | boolean>;

const inputCls =
  "w-full rounded border border-gray-300 px-3 py-2 text-sm text-gray-900 placeholder-gray-400";

function isoToBr(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : iso;
}

function brToIso(br: string): string {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(br);
  return m ? `${m[3]}-${m[2]}-${m[1]}` : br;
}

function initialDisplay(field: ParameterField, initial: unknown): string | boolean {
  if (initial === undefined || initial === null) {
    return field.type === "boolean" ? false : "";
  }
  if (field.type === "boolean") return Boolean(initial);
  if (field.type === "list" && Array.isArray(initial)) return initial.join(", ");
  if (field.type === "date" && typeof initial === "string") return brToIso(initial);
  return String(initial);
}

function parseList(raw: string, itemType: ParameterField["itemType"]): unknown[] {
  const items = raw
    .split(/[,\n]/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (itemType === "number") {
    return items.map((s) => Number(s)).filter((n) => !Number.isNaN(n));
  }
  return items;
}

function coerce(field: ParameterField, raw: string | boolean): unknown {
  if (field.type === "boolean") return Boolean(raw);
  const s = String(raw);
  if (s === "") return undefined;
  if (field.type === "number") {
    const n = Number(s);
    return Number.isNaN(n) ? s : n;
  }
  if (field.type === "date") return isoToBr(s);
  if (field.type === "list") return parseList(s, field.itemType);
  return s;
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
    for (const f of schema) v[f.name] = initialDisplay(f, initial?.[f.name]);
    return v;
  });

  const set = (name: string, raw: string | boolean) =>
    setValues((v) => ({ ...v, [name]: raw }));

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const out: Record<string, unknown> = {};
    for (const f of schema) {
      const coerced = coerce(f, values[f.name] ?? "");
      if (coerced === undefined) continue;
      if (Array.isArray(coerced) && coerced.length === 0 && !f.required) continue;
      out[f.name] = coerced;
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
          {f.type !== "boolean" && (
            <label className="block text-xs font-medium text-gray-600 mb-1">
              {f.label}
              {f.required && <span className="text-red-500 ml-0.5">*</span>}
            </label>
          )}
          {f.type === "select" ? (
            <select
              required={f.required}
              value={String(values[f.name] ?? "")}
              onChange={(e) => set(f.name, e.target.value)}
              className={inputCls}
            >
              <option value="">Selecione…</option>
              {(f.options ?? []).map((o) => (
                <option key={o} value={o}>
                  {o}
                </option>
              ))}
            </select>
          ) : f.type === "boolean" ? (
            <label className="flex items-center gap-2 text-sm text-gray-900">
              <input
                type="checkbox"
                checked={Boolean(values[f.name])}
                onChange={(e) => set(f.name, e.target.checked)}
                className="h-4 w-4 rounded border-gray-300"
              />
              {f.label}
              {f.required && <span className="text-red-500">*</span>}
            </label>
          ) : f.type === "list" ? (
            <textarea
              required={f.required}
              placeholder={
                f.placeholder ??
                (f.itemType === "number"
                  ? "Ex: 4814, 6861, 11118 (separe por vírgula ou linha)"
                  : "Um item por linha ou separados por vírgula")
              }
              value={String(values[f.name] ?? "")}
              onChange={(e) => set(f.name, e.target.value)}
              rows={3}
              className={`${inputCls} font-mono`}
            />
          ) : (
            <input
              required={f.required}
              type={f.type === "date" ? "date" : f.type === "number" ? "number" : "text"}
              placeholder={f.placeholder}
              value={String(values[f.name] ?? "")}
              onChange={(e) => set(f.name, e.target.value)}
              className={inputCls}
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
