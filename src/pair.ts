/**
 * Ownership pairing (PRD §7).
 *
 * The stable card URL identifies which computer to show — it is NOT proof of
 * ownership. First open: mini app gets a short-lived code; the owner texts
 * "connect <code>" in the same iMessage conversation; the browser that saw
 * the code exchanges it once for a session token. A forwarded card link shows
 * a Connect screen to anyone who isn't the owner — the code only completes
 * for a texter whose own binding resolves to the same ref.
 */
import { randomBytes, createHash } from "node:crypto";

export interface Challenge {
  code: string;
  ref: string;
  status: "pending" | "approved" | "consumed";
  createdAt: string;
}
export interface Session {
  token: string;
  ref: string;
  createdAt: string;
}

export interface PairStore {
  challenges: Record<string, Challenge>; // keyed by code
  sessions: Record<string, Session>; // keyed by token
}

const CODE_TTL_MS = 10 * 60 * 1000;
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export function createChallenge(store: PairStore, ref: string, forceNew = false): Challenge {
  // reuse the latest pending challenge for this ref instead of stacking codes —
  // unless the caller explicitly wants a new one ("New code" must visibly change)
  if (forceNew) {
    for (const c of Object.values(store.challenges)) {
      if (c.ref === ref && c.status === "pending") c.createdAt = new Date(0).toISOString();
    }
  } else {
    for (const c of Object.values(store.challenges)) {
      if (c.ref === ref && c.status === "pending" && fresh(c.createdAt, CODE_TTL_MS)) return c;
    }
  }
  const code = randomBytes(3).toString("hex").toUpperCase(); // 6 hex chars, easy to type
  const ch: Challenge = { code, ref, status: "pending", createdAt: new Date().toISOString() };
  store.challenges[code] = ch;
  return ch;
}

/** Approve a pending challenge — only when the texter owns the same ref. */
export function approveChallenge(store: PairStore, code: string, texterRef: string): boolean {
  const ch = store.challenges[code.toUpperCase()];
  if (!ch || ch.status !== "pending" || !fresh(ch.createdAt, CODE_TTL_MS)) return false;
  if (ch.ref !== texterRef) return false; // texting owner must map to the same computer
  ch.status = "approved";
  return true;
}

/** Exchange an approved code for a session token (one-shot). */
export function exchangeChallenge(store: PairStore, code: string): Session | null {
  const ch = store.challenges[code.toUpperCase()];
  if (!ch || ch.status !== "approved") return null;
  ch.status = "consumed";
  const token = "ps_" + randomBytes(24).toString("hex");
  const s: Session = { token, ref: ch.ref, createdAt: new Date().toISOString() };
  store.sessions[token] = s;
  return s;
}

export function sessionRef(store: PairStore, token: string | undefined | null): string | null {
  if (!token) return null;
  const s = store.sessions[token];
  if (!s || !fresh(s.createdAt, SESSION_TTL_MS)) return null;
  return s.ref;
}

/** Debug helper for status polling without consuming. */
export function challengeStatus(store: PairStore, code: string): string {
  const ch = store.challenges[code.toUpperCase()];
  if (!ch) return "unknown";
  if (ch.status === "pending" && !fresh(ch.createdAt, CODE_TTL_MS)) return "expired";
  return ch.status;
}

function fresh(iso: string, ttl: number): boolean {
  return Date.now() - new Date(iso).getTime() < ttl;
}
