import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  PolicyError,
  loadPolicy,
  parsePolicy,
  policyHash,
  realAuthorization,
  type GrantFacts,
  type Policy,
} from '../../src/autonomy/index.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('política autônoma', () => {
  it('sem arquivo ou com {}: desligada, só simulação, pretensão R$ 1.800 e bolsa mínima R$ 1.200', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pol-'));
    dirs.push(dir);
    for (const policy of [loadPolicy(join(dir, 'nao-existe.json')), parsePolicy({})]) {
      expect(policy.enabled).toBe(false);
      expect(policy.real.authorized).toBe(false);
      expect(policy.salaryExpectation).toEqual({ amount: 1800, currency: 'BRL' });
      expect(policy.rules.minStipend).toBe(1200);
      expect(policy.rules.verdicts).toEqual(['apto']);
      expect(policy.limits.maxPerRun).toBe(5);
    }
  });

  it('rejeita chave desconhecida, valores fora do limite e JSON inválido (nunca cai no padrão)', () => {
    expect(() => parsePolicy({ envioLivre: true })).toThrow(PolicyError);
    expect(() => parsePolicy({ limits: { maxPerRun: 1000 } })).toThrow(/limits/);
    expect(() => parsePolicy({ rules: { verdicts: ['inapto'] } })).toThrow(PolicyError);
    const dir = mkdtempSync(join(tmpdir(), 'pol-'));
    dirs.push(dir);
    const file = join(dir, 'autonomy.json');
    writeFileSync(file, '{ quebrado');
    expect(() => loadPolicy(file)).toThrow(/JSON válido/);
  });

  it('o envio real exige opt-in, concessão vigente da política atual e conector', () => {
    const now = new Date('2026-10-24T12:00:00Z');
    const base = { enabled: true, real: { authorized: true, connectors: ['email'] } };
    const policy = parsePolicy(base);
    const grant = (over: Partial<GrantFacts> = {}): GrantFacts => ({
      id: 7,
      validUntil: '2026-11-23T12:00:00.000Z',
      policyHash: policyHash(policy),
      connectors: ['email'],
      maxPerDay: 10,
      maxPerRun: 5,
      minIntervalSeconds: 900,
      ...over,
    });
    expect(realAuthorization(policy, grant(), now)).toMatchObject({ ok: true });
    const reason = (p: Policy, g: GrantFacts | null) => {
      const result = realAuthorization(p, g, now);
      return result.ok ? 'ok' : result.reason;
    };
    expect(reason(parsePolicy({}), grant())).toMatch(/desligado/);
    expect(reason(parsePolicy({ enabled: true }), grant())).toMatch(/real.authorized/);
    expect(reason(parsePolicy({ enabled: true, real: { authorized: true } }), grant())).toMatch(
      /conector/,
    );
    expect(reason(policy, null)).toMatch(/sem concessão/);
    expect(reason(policy, grant({ validUntil: '2026-10-24T11:59:59.000Z' }))).toMatch(/vencida/);
    expect(reason(policy, grant({ policyHash: 'outro' }))).toMatch(/política mudou/);
    expect(reason(policy, grant({ connectors: [] }))).toMatch(/não cobre/);
  });
});
