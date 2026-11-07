import { authHeaders } from "./identity";

export const API_BASE: string = (import.meta.env.VITE_API_URL as string | undefined) || "";

export class ApiError extends Error {
  status: number;
  data: unknown;
  constructor(message: string, status: number, data: unknown) {
    super(message);
    this.status = status;
    this.data = data;
  }
}

export async function api<T = unknown>(
  path: string,
  options: RequestInit & { auth?: boolean } = {}
): Promise<T> {
  const { auth = true, ...rest } = options;
  const authHdrs = auth ? await authHeaders().catch(() => null) : null;
  const res = await fetch(`${API_BASE}${path}`, {
    ...rest,
    headers: {
      "content-type": "application/json",
      ...(authHdrs || {}),
      ...(rest.headers || {}),
    },
  });
  const text = await res.text();
  let data: unknown = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = { raw: text };
    }
  }
  if (!res.ok) {
    const d = data as { error?: string; raw?: string } | null;
    throw new ApiError(d?.error || d?.raw || `http ${res.status}`, res.status, data);
  }
  return data as T;
}
