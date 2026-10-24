import { beforeEach, describe, expect, it } from 'vitest';
import {
  GrantError,
  createGrant,
  effectiveInterval,
  grantCode,
  latestGrant,
  listGrants,
  parsePolicy,
  previewGrant,
  realAuthorization,
  revokeGrant,
} from '../../src/autonomy/index.js';
import { IN_MEMORY, openDatabase, runMigrations, type Db } from '../../src/db/index.js';

const NOW = new Date('2026-10-24T12:00:00Z');
const policy = parsePolicy({
  enabled: true,
  limits: { maxPerDay: 10, maxPerRun: 5, cooldownSeconds: 180 },
  real: { authorized: true, connectors: ['email'] },
});
let db: Db;
beforeEach(() => {
  db = openDatabase(IN_MEMORY);
  runMigrations(db);
});

describe('concessão (autorização permanente)', () => {
  it('o resumo mostra limites, validade e código, e o intervalo efetivo respeita o piso do e-mail (15 min)', () => {
    const preview = previewGrant(policy, 30, NOW);
    expect(preview.summary.join('\n')).toContain('5 por execução, 10 por dia');
    expect(preview.validUntil.slice(0, 10)).toBe('2026-11-23');
    expect(effectiveInterval(policy)).toBe(900);
    expect(effectiveInterval(parsePolicy({ limits: { cooldownSeconds: 1800 } }))).toBe(1800);
    expect(() => previewGrant(policy, 0, NOW)).toThrow(GrantError);
    expect(() => previewGrant(policy, 91, NOW)).toThrow(GrantError);
  });

  it('exige o código da política atual, motivo e política ligada; nada é gravado sem isso', () => {
    const base = { days: 30, reason: 'autorizo', now: NOW };
    expect(() => createGrant(db, policy, { ...base, confirm: 'errado' })).toThrow(/Código/);
    expect(() =>
      createGrant(db, policy, { ...base, reason: ' ', confirm: grantCode(policy, 30) }),
    ).toThrow(/motivo/);
    const off = parsePolicy({});
    expect(() => createGrant(db, off, { ...base, confirm: grantCode(off, 30) })).toThrow(/ligada/);
    expect(listGrants(db)).toHaveLength(0);
    // O código vale para a política E para o prazo exatos.
    expect(() => createGrant(db, policy, { ...base, confirm: grantCode(policy, 29) })).toThrow(
      /Código/,
    );
  });

  it('registra a concessão com os limites congelados e ela autoriza o envio real até mudar a política', () => {
    const id = createGrant(db, policy, {
      days: 30,
      confirm: grantCode(policy, 30),
      reason: 'autorizo',
      now: NOW,
    });
    const grant = latestGrant(db);
    expect(grant).toMatchObject({
      id,
      maxPerDay: 10,
      maxPerRun: 5,
      minIntervalSeconds: 900,
      connectors: ['email'],
    });
    expect(realAuthorization(policy, grant, NOW)).toMatchObject({ ok: true });
    const changed = parsePolicy({ ...policy, limits: { ...policy.limits, maxPerDay: 50 } });
    const stale = realAuthorization(changed, grant, NOW);
    expect(stale.ok).toBe(false);
    expect(stale.ok ? '' : stale.reason).toMatch(/política mudou/);
    const later = new Date('2026-11-24T00:00:00Z');
    const expired = realAuthorization(policy, grant, later);
    expect(expired.ok).toBe(false);
    expect(expired.ok ? '' : expired.reason).toMatch(/vencida/);
  });

  it('a revogação tem efeito imediato, exige motivo e não é repetível', () => {
    const id = createGrant(db, policy, {
      days: 30,
      confirm: grantCode(policy, 30),
      reason: 'autorizo',
      now: NOW,
    });
    expect(() => {
      revokeGrant(db, id, '', NOW);
    }).toThrow(GrantError);
    revokeGrant(db, id, 'mudei de ideia', NOW);
    expect(latestGrant(db)).toBeNull();
    expect(realAuthorization(policy, latestGrant(db), NOW)).toMatchObject({ ok: false });
    expect(() => {
      revokeGrant(db, id, 'de novo', NOW);
    }).toThrow(/já revogada/);
    expect(listGrants(db)[0]).toMatchObject({ id, revoked_at: NOW.toISOString() });
  });
});
