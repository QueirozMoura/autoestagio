import { createHash } from 'node:crypto';
import type { Db } from '../db/index.js';
import { policyHash, type GrantFacts, type Policy } from './policy.js';

export const MAX_GRANT_DAYS = 90;
const MIN_EMAIL_INTERVAL_SECONDS = 15 * 60;

export class GrantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GrantError';
  }
}

/** Código de confirmação: muda se a política (limites, regras, conectores) ou o prazo mudarem. */
export const grantCode = (policy: Policy, days: number): string =>
  createHash('sha256')
    .update(`autonomo-concessao-v1|${policyHash(policy)}|${days}`)
    .digest('hex')
    .slice(0, 8);

export interface GrantPreview {
  days: number;
  code: string;
  validUntil: string;
  summary: string[];
}

export function previewGrant(policy: Policy, days: number, now: Date): GrantPreview {
  if (!Number.isInteger(days) || days < 1 || days > MAX_GRANT_DAYS)
    throw new GrantError(`A validade deve ficar entre 1 e ${MAX_GRANT_DAYS} dias.`);
  const validUntil = new Date(now.getTime() + days * 86_400_000).toISOString();
  return {
    days,
    code: grantCode(policy, days),
    validUntil,
    summary: [
      `Conectores: ${policy.real.connectors.join(', ') || '(nenhum)'}`,
      `Manifesto AUTO_APPLY (SHA-256): ${policy.real.autoApplyManifestSha256 ?? '(ausente: AUTO_APPLY real bloqueado)'}`,
      `Limites: ${policy.limits.maxPerRun} por execução, ${policy.limits.maxPerDay} por dia; intervalo mínimo efetivo entre e-mails: ${effectiveInterval(policy)} s`,
      `Pretensão salarial: ${policy.salaryExpectation.currency} ${policy.salaryExpectation.amount}; bolsa mínima divulgada: ${policy.rules.minStipend}`,
      `Vereditos aceitos: ${policy.rules.verdicts.join(', ')}; desconhecidos tolerados: ${policy.rules.tolerateUnknown.join(', ') || 'nenhum'}`,
      `Validade: ${days} dia(s), até ${validUntil.slice(0, 10)}`,
    ],
  };
}

/** O canal de e-mail tem piso próprio de 15 min entre envios: a política só pode aumentá-lo. */
export const effectiveInterval = (policy: Policy): number =>
  Math.max(policy.limits.cooldownSeconds, MIN_EMAIL_INTERVAL_SECONDS);

export function createGrant(
  db: Db,
  policy: Policy,
  options: { days: number; confirm: string; reason: string; now?: Date },
): number {
  const now = options.now ?? new Date();
  const preview = previewGrant(policy, options.days, now);
  if (options.reason.trim() === '') throw new GrantError('Informe o motivo da autorização.');
  if (options.confirm.trim().toLowerCase() !== preview.code)
    throw new GrantError(
      'Código de confirmação ausente ou diferente da política atual; rode "autonomo grant" sem --confirm para ver o resumo e o código.',
    );
  if (!policy.enabled || !policy.real.authorized || policy.real.connectors.length === 0)
    throw new GrantError(
      'A política precisa estar ligada (enabled), com real.authorized=true e ao menos um conector.',
    );
  return Number(
    db
      .prepare(
        `INSERT INTO autonomous_grants
           (created_at, valid_until, policy_hash, connectors, max_per_day, max_per_run,
            min_interval_seconds, salary_expectation, min_stipend, reason)
         VALUES (@at, @until, @hash, @connectors, @perDay, @perRun, @interval, @salary, @stipend, @reason)`,
      )
      .run({
        at: now.toISOString(),
        until: preview.validUntil,
        hash: policyHash(policy),
        connectors: JSON.stringify(policy.real.connectors),
        perDay: policy.limits.maxPerDay,
        perRun: policy.limits.maxPerRun,
        interval: effectiveInterval(policy),
        salary: policy.salaryExpectation.amount,
        stipend: policy.rules.minStipend,
        reason: options.reason.trim().slice(0, 300),
      }).lastInsertRowid,
  );
}

export function revokeGrant(db: Db, id: number, reason: string, now: Date = new Date()): void {
  if (reason.trim() === '') throw new GrantError('Informe o motivo da revogação.');
  const result = db
    .prepare(
      'UPDATE autonomous_grants SET revoked_at = ?, revoked_reason = ? WHERE id = ? AND revoked_at IS NULL',
    )
    .run(now.toISOString(), reason.trim().slice(0, 300), id);
  if (result.changes === 0) throw new GrantError(`Concessão ${id} não encontrada ou já revogada.`);
}

interface GrantRow {
  id: number;
  valid_until: string;
  policy_hash: string;
  connectors: string;
  max_per_day: number;
  max_per_run: number;
  min_interval_seconds: number;
}

/** A concessão mais recente não revogada (a validade e o hash são conferidos por `realAuthorization`). */
export function latestGrant(db: Db): GrantFacts | null {
  const row = db
    .prepare(
      `SELECT id, valid_until, policy_hash, connectors, max_per_day, max_per_run, min_interval_seconds
         FROM autonomous_grants WHERE revoked_at IS NULL ORDER BY id DESC LIMIT 1`,
    )
    .get() as GrantRow | undefined;
  return row === undefined
    ? null
    : {
        id: row.id,
        validUntil: row.valid_until,
        policyHash: row.policy_hash,
        connectors: JSON.parse(row.connectors) as string[],
        maxPerDay: row.max_per_day,
        maxPerRun: row.max_per_run,
        minIntervalSeconds: row.min_interval_seconds,
      };
}

export function listGrants(
  db: Db,
): (GrantRow & { created_at: string; revoked_at: string | null; reason: string })[] {
  return db
    .prepare(
      `SELECT id, created_at, valid_until, policy_hash, connectors, max_per_day, max_per_run,
              min_interval_seconds, reason, revoked_at FROM autonomous_grants ORDER BY id DESC`,
    )
    .all() as (GrantRow & { created_at: string; revoked_at: string | null; reason: string })[];
}
