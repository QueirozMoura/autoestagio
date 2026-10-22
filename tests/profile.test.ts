import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConfigError, parseProfile } from '../src/config/index.js';
import { PROJECT_ROOT } from '../src/utils/paths.js';

const example: unknown = JSON.parse(
  readFileSync(join(PROJECT_ROOT, 'config', 'profile.example.json'), 'utf8'),
);

describe('parseProfile', () => {
  it('valida o perfil de exemplo', () => {
    const profile = parseProfile(example);
    expect(profile.city).toBe('São Paulo, SP');
    expect(profile.minStipend.amount).toBe(1200);
    expect(profile.workModes.onsite.maxCommuteMinutesPerWay).toBe(70);
  });

  it('rejeita perfil sem tecnologias', () => {
    const invalid = { ...(example as object), technologies: [] };
    expect(() => parseProfile(invalid)).toThrow(ConfigError);
  });

  it('rejeita moeda inválida', () => {
    const base = example as { minStipend: object };
    const invalid = { ...base, minStipend: { ...base.minStipend, currency: 'REAIS' } };
    expect(() => parseProfile(invalid)).toThrow(/minStipend\.currency/);
  });
});
