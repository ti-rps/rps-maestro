import axios from "axios";

const BASE_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8080/api/v1";

export const api = axios.create({ baseURL: BASE_URL });

api.interceptors.request.use((config) => {
  const token = typeof window !== "undefined" ? localStorage.getItem("token") : null;
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

api.interceptors.response.use(
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

export type ParameterFieldType = "text" | "date" | "number" | "select";

export interface ParameterField {
  name: string;
  label: string;
  type: ParameterFieldType;
  required?: boolean;
  options?: string[];
  placeholder?: string;
}

export type ParameterSchema = ParameterField[];

export interface Automation {
  id: number;
  name: string;
  description?: string;
  scriptPath: string;
  queueName: string;
  defaultParams?: Record<string, unknown>;
  parameterSchema?: ParameterSchema;
  createdAt: string;
  updatedAt: string;
}

export interface Job {
  id: string;
  automationId: number;
  userId?: number;
  status: "pending" | "running" | "completed" | "failed";
  parameters?: Record<string, unknown>;
  result?: Record<string, unknown>;
  startedAt?: string;
  completedAt?: string;
  createdAt: string;
  retryCount?: number;
}

export interface JobLog {
  id: number;
  jobId: string;
  timestamp: string;
  level: string;
  message: string;
}

export interface Schedule {
  id: number;
  automationId: number;
  cronExpression: string;
  parameters?: Record<string, unknown>;
  nextRunAt?: string;
  isEnabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface User {
  id: number;
  name: string;
  email: string;
  role: string;
  createdAt: string;
  updatedAt: string;
}

// ── Auth ─────────────────────────────────────────────────────────────────────

export const authApi = {
  login: (email: string, password: string) =>
    api.post<{ token: string; expires_in: number; user: User }>("/auth/login", { email, password }),
  refresh: () => api.post<{ token: string; expires_in: number }>("/auth/refresh"),
};

// ── Automations ───────────────────────────────────────────────────────────────

export const automationsApi = {
  list: () => api.get<Automation[]>("/automations"),
  get: (id: number) => api.get<Automation>(`/automations/${id}`),
  create: (data: Omit<Automation, "id" | "createdAt" | "updatedAt">) =>
    api.post<Automation>("/automations", data),
  update: (id: number, data: Partial<Automation>) =>
    api.put<Automation>(`/automations/${id}`, data),
  delete: (id: number) => api.delete(`/automations/${id}`),
  execute: (id: number, params?: Record<string, unknown>) =>
    api.post<Job>(`/automations/${id}/execute`, params ?? {}),
};

// ── Jobs ──────────────────────────────────────────────────────────────────────

export const jobsApi = {
  get: (id: string) => api.get<Job>(`/jobs/${id}`),
  logs: (id: string) => api.get<JobLog[]>(`/jobs/${id}/logs`),
};

// ── Schedules ─────────────────────────────────────────────────────────────────

export const schedulesApi = {
  list: () => api.get<Schedule[]>("/schedules"),
  get: (id: number) => api.get<Schedule>(`/schedules/${id}`),
  create: (data: Omit<Schedule, "id" | "createdAt" | "updatedAt" | "nextRunAt">) =>
    api.post<Schedule>("/schedules", data),
  update: (id: number, data: Partial<Schedule>) =>
    api.put<Schedule>(`/schedules/${id}`, data),
  delete: (id: number) => api.delete(`/schedules/${id}`),
};
