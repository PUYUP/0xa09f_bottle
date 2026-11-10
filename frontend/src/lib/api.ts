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

// Server clock offset (seconds) learned from the HTTP Date header on every
// response — bottle timestamps are server-stamped while local read markers
// use the client clock, so badge comparisons need this normalization.
let serverOffsetSec = 0;
export function getServerOffsetSec(): number {
  return serverOffsetSec;
}

// noteServerTime refines the offset from an explicit server timestamp
// (e.g. the stats endpoint's `now` field) — same second resolution as the
// Date header but doesn't depend on header parsing.
export function noteServerTime(serverSec: number) {
  serverOffsetSec = serverSec - Math.floor(Date.now() / 1000);
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
  const dateHdr = res.headers.get("date");
  if (dateHdr) {
    const serverSec = Math.floor(new Date(dateHdr).getTime() / 1000);
    if (!Number.isNaN(serverSec)) {
      serverOffsetSec = serverSec - Math.floor(Date.now() / 1000);
    }
  }
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
