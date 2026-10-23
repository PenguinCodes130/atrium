// Skeleton (architecture v3 sections 2 and 7): the one way to write the audit log, usable from every wave.
// The log screen and CSV export belong to the actions subsystem.
import "server-only";
import { randomUUID } from "node:crypto";
import type { AuditEntry, AuditEvent, Principal } from "@/core/contracts";
import { db } from "@/core/db";
import { auditLog } from "@/db/schema/audit";

// Field names that must never reach the log with a value (section 7: secret fields are recorded as "[set]").
const SECRET_KEY = /(token|secret|password|passwd|api[-_]?key|authorization|cookie|pin)/i;

export function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = SECRET_KEY.test(k) ? (v == null || v === "" ? v : "[set]") : redact(v);
    return out;
  }
  return value;
}

export function actorOf(p: Principal, ip?: string): AuditEntry["actor"] {
  switch (p.kind) {
    case "user":
      return { kind: p.kind, userId: p.userId, ip };
    case "agent":
      return { kind: p.kind, userId: p.userId, tokenId: p.tokenId, agentName: p.agentName, ip };
    case "builtin-agent":
      return { kind: p.kind, userId: p.userId, agentName: "setup agent", ip };
    case "guest":
      return { kind: p.kind, guestLinkId: p.guestLinkId, guestLabel: p.label, ip };
  }
}

// Every principal carries `via` (users, agents, guests) or `conversationId` (the built-in agent); a stored actor has neither.
function isPrincipal(a: Principal | AuditEntry["actor"]): a is Principal {
  return "via" in a || "conversationId" in a;
}

export type AuditInput = {
  actor: Principal | AuditEntry["actor"];
  event: AuditEvent;
  target?: AuditEntry["target"];
  proposalId?: string;
  result: AuditEntry["result"];
  detail?: Record<string, unknown>;
  ip?: string;
  at?: Date;
};

/** Appends one entry and returns it. Details are redacted before they are stored. */
export function write(input: AuditInput): AuditEntry {
  const actor = isPrincipal(input.actor) ? actorOf(input.actor, input.ip) : input.actor;
  const at = input.at ?? new Date();
  const detail = input.detail ? (redact(input.detail) as Record<string, unknown>) : undefined;
  const entry: AuditEntry = {
    id: randomUUID(),
    at: at.toISOString(),
    actor,
    event: input.event,
    target: input.target,
    proposalId: input.proposalId,
    result: input.result,
    detail,
  };
  db()
    .insert(auditLog)
    .values({
      id: entry.id,
      at,
      actorKind: actor.kind,
      actorUserId: actor.userId ?? null,
      actorTokenId: actor.tokenId ?? null,
      actorAgentName: actor.agentName ?? null,
      actorGuestLinkId: actor.guestLinkId ?? null,
      actorGuestLabel: actor.guestLabel ?? null,
      actorIp: actor.ip ?? null,
      event: entry.event,
      targetType: entry.target?.type ?? null,
      targetId: entry.target?.id ?? null,
      targetLabel: entry.target?.label ?? null,
      proposalId: entry.proposalId ?? null,
      result: entry.result,
      detail: detail ?? null,
    })
    .run();
  return entry;
}

export const audit = { write };
