/**
 * Minimal Maritime Computers REST adapter.
 * Docs: https://maritime.sh/docs/api
 */

const API = process.env.MARITIME_API_URL ?? "https://api.maritime.sh";
const TOKEN = process.env.MARITIME_TOKEN!;

export interface MaritimeComputer {
  id: string;
  os: string;
  arch: string;
  externalUserId: string | null;
  name: string | null;
  status: string;
  screen: { width: number; height: number; modelWidth: number } | null;
  mode: string;
  session: unknown;
  lastActionAt: string | null;
  errorMessage: string | null;
  createdAt: string;
}

export interface ViewerGrant {
  url: string;
  expiresAt: string;
  mode: string;
}

async function req<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      "Content-Type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Maritime ${method} ${path} -> ${res.status}: ${text.slice(0, 300)}`);
  }
  const ct = res.headers.get("content-type") ?? "";
  if (!ct.includes("json")) return (await res.arrayBuffer()) as T;
  return (await res.json()) as T;
}

export async function listComputers(): Promise<MaritimeComputer[]> {
  const data = await req<{ computers: MaritimeComputer[] }>("GET", "/api/v1/computers");
  return data.computers;
}

export async function getOrCreateComputer(
  externalUserId: string,
  opts: { name?: string; os?: string } = {},
): Promise<MaritimeComputer> {
  const existing = (await listComputers()).find(
    (c) => c.externalUserId === externalUserId && c.os === (opts.os ?? "linux"),
  );
  if (existing) return existing;
  const created = await req<MaritimeComputer>("POST", "/api/v1/computers", {
    name: opts.name ?? `imessage-${externalUserId}`,
    os: opts.os ?? "linux",
    externalUserId,
  });
  if (created?.id) return created;
  // some responses wrap the computer — fall back to a fresh list lookup
  const again = (await listComputers()).find(
    (c) => c.externalUserId === externalUserId && c.os === (opts.os ?? "linux"),
  );
  if (!again) throw new Error("computer create succeeded but is not listed");
  return again;
}

export async function getComputer(id: string): Promise<MaritimeComputer> {
  return req<MaritimeComputer>("GET", `/api/v1/computers/${id}`);
}

export async function wakeComputer(id: string): Promise<MaritimeComputer> {
  // wake's response isn't a bare computer — refetch for a guaranteed shape
  await req("POST", `/api/v1/computers/${id}/wake`, {});
  return getComputer(id);
}

export async function sleepComputer(id: string): Promise<MaritimeComputer> {
  return req<MaritimeComputer>("POST", `/api/v1/computers/${id}/sleep`, {});
}

export async function createViewer(id: string, mode: "watch" | "control" = "watch"): Promise<ViewerGrant> {
  return req<ViewerGrant>("POST", `/api/v1/computers/${id}/viewer`, { mode });
}

export async function screenshot(id: string): Promise<Buffer> {
  const buf = await req<ArrayBuffer>("GET", `/api/v1/computers/${id}/screenshot`);
  return Buffer.from(buf);
}

export async function desktopAction(id: string, action: Record<string, unknown>) {
  return req("POST", `/api/v1/computers/${id}/actions`, action);
}

export async function closeSession(id: string) {
  return req("POST", `/api/v1/computers/${id}/sessions/close`, {});
}

export interface ExecOut {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

export async function execOnComputer(id: string, command: string, timeoutS = 30): Promise<ExecOut> {
  return req<ExecOut>("POST", `/api/v1/computers/${id}/exec`, { command, timeoutS });
}

export async function writeFile(id: string, path: string, content: string | Buffer): Promise<void> {
  const res = await fetch(`${API}/api/v1/computers/${id}/files?path=${encodeURIComponent(path)}`, {
    method: "PUT",
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/octet-stream" },
    body: content,
  });
  if (!res.ok) throw new Error(`files PUT ${path} -> ${res.status}: ${await res.text().catch(() => "")}`);
}

export async function readFileOnComputer(id: string, path: string): Promise<Buffer> {
  const res = await fetch(`${API}/api/v1/computers/${id}/files?path=${encodeURIComponent(path)}`, {
    headers: { Authorization: `Bearer ${TOKEN}` },
  });
  if (!res.ok) throw new Error(`files GET ${path} -> ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

export async function takeoverComplete(id: string, viewerToken: string, success = true, note = "") {
  // the endpoint authenticates with the control-viewer grant token (the t= param
  // Maritime bakes into the link), not the mk_ API key
  const res = await fetch(`${API}/api/v1/computers/${id}/takeover/complete`, {
    method: "POST",
    headers: { Authorization: `Bearer ${viewerToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ success, note }),
  });
  if (!res.ok) throw new Error(`takeover/complete -> ${res.status}: ${await res.text().catch(() => "")}`);
}
