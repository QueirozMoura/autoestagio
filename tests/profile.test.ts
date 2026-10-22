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

  it('campos novos são opcionais: dado ausente significa "não informado"', () => {
    const profile = parseProfile(example);
    expect(profile.languages).toBeUndefined();
    expect(profile.availability).toBeUndefined();
    expect(profile.commute).toBeUndefined();
    expect(profile.approval).toBeUndefined();
    expect(profile.education.currentSemester).toBeUndefined();
  });

  it('valida idioma, disponibilidade, deslocamento e aprovação', () => {
    const base = example as object;
    const ok = parseProfile({
      ...base,
      languages: [{ language: 'Inglês', level: 'intermediario' }],
      availability: { hoursPerWeek: { min: 20, max: 30 }, startFrom: '2026-12-01' },
      commute: [{ keywords: ['pinheiros'], minutesPerWay: 45, source: 'teste' }],
      approval: { cvFile: 'cv.pdf', cvSha256: 'b'.repeat(64), approvedAt: '2026-10-22' },
    });
    expect(ok.languages?.[0]?.level).toBe('intermediario');
    expect(ok.languages?.[0]?.scope).toBe('geral'); // padrão: sem restrição de uso

    for (const invalid of [
      { languages: [{ language: 'Inglês', level: 'nativo' }] },
      { availability: { hoursPerWeek: { min: 30, max: 20 }, startFrom: '2026-12-01' } },
      { availability: { hoursPerWeek: { min: 20, max: 30 }, startFrom: 'dezembro' } },
      { languages: [{ language: 'Inglês', level: 'basico', scope: 'conversacao' }] },
      { commute: [{ keywords: [], minutesPerWay: 45, source: 'teste' }] },
      { approval: { cvFile: 'cv.pdf', cvSha256: 'b'.repeat(64), approvedAt: 'ontem' } },
      { approval: { cvFile: 'cv.pdf', approvedAt: '2026-10-22' } }, // sem SHA-256
      { approval: { cvFile: 'cv.pdf', cvSha256: 'xyz', approvedAt: '2026-10-22' } },
    ]) {
      expect(() => parseProfile({ ...base, ...invalid })).toThrow(ConfigError);
    }
  });

  it('vaga sem bolsa nunca é descartada: "descartar" é rejeitado', () => {
    const base = example as { minStipend: object };
    const invalid = { ...base, minStipend: { ...base.minStipend, whenUnknown: 'descartar' } };
    expect(() => parseProfile(invalid)).toThrow(/whenUnknown/);
  });
});
