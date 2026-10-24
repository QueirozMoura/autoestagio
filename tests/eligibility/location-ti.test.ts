import { describe, expect, it } from 'vitest';
import { evaluateJob, type Criterion } from '../../src/eligibility/index.js';
import { job, profile } from '../helpers/eligibility.js';

const get = (criteria: readonly Criterion[], id: string) => criteria.find((c) => c.id === id);
const withCommute = (commute: Record<string, unknown>[], extra: Record<string, unknown> = {}) =>
  profile({ commute, home: { label: 'Guarapiranga, Zona Sul de São Paulo' }, ...extra });

describe('deslocamento a partir da Guarapiranga', () => {
  const entry = (minutes: number, over: Record<string, unknown> = {}) => ({
    keywords: ['paulista'],
    minutesPerWay: minutes,
    source: 'Google Maps, transporte público',
    confirmedAt: '2026-10-23',
    ...over,
  });
  const run = (minutes: number, location = 'São Paulo - Av. Paulista') =>
    evaluateJob(withCommute([entry(minutes)]), job({ workMode: 'presencial', location }));

  it('até 70 min: adequado, com origem, fonte e data', () => {
    const c = get(run(70).criteria, 'deslocamento');
    expect(c?.outcome).toBe('atende');
    expect(c?.detail).toContain('Guarapiranga');
    expect(c?.detail).toContain('Google Maps');
    expect(c?.detail).toContain('2026-10-23');
  });

  it('71 a 80: revisão manual; acima de 80: incompatível', () => {
    expect(get(run(71).criteria, 'deslocamento')?.outcome).toBe('indeterminado');
    expect(get(run(80).criteria, 'deslocamento')?.outcome).toBe('indeterminado');
    expect(get(run(81).criteria, 'deslocamento')?.outcome).toBe('nao_atende');
  });

  it('o limite de revisão é configurável no perfil', () => {
    const custom = profile({
      commute: [entry(85)],
      workModes: {
        preferred: ['remoto', 'hibrido'],
        onsite: { allowed: true, maxCommuteMinutesPerWay: 70, reviewMaxCommuteMinutesPerWay: 90 },
      },
    });
    expect(
      get(
        evaluateJob(custom, job({ workMode: 'presencial', location: 'São Paulo - Av. Paulista' }))
          .criteria,
        'deslocamento',
      )?.outcome,
    ).toBe('indeterminado');
  });

  it('sem tempo confirmado: pendente, sem inventar minutos nem usar distância', () => {
    const result = evaluateJob(
      withCommute([]),
      job({ workMode: 'hibrido', location: 'São Paulo - Itaim Bibi' }),
    );
    const c = get(result.criteria, 'deslocamento');
    expect(c?.outcome).toBe('indeterminado');
    expect(c?.detail).not.toContain('Deslocamento verificado');
    expect(c?.detail).toContain('locais registrar');
    expect(result.verdict).toBe('revisao_humana');
  });

  it('um tempo confirmado vale para toda vaga naquele local (reuso)', () => {
    const p = withCommute([entry(60)]);
    for (const company of ['A', 'B'])
      expect(
        get(
          evaluateJob(
            p,
            job({ company, workMode: 'hibrido', location: 'São Paulo - Av. Paulista' }),
          ).criteria,
          'deslocamento',
        )?.outcome,
      ).toBe('atende');
  });
});

describe('região metropolitana e outras cidades', () => {
  it('Grande São Paulo sem tempo confirmado: pendente (não rejeita nem presume)', () => {
    for (const location of [
      'Osasco, SP',
      'Guarulhos - SP',
      'São Caetano do Sul, SP',
      'Barueri, SP',
    ]) {
      const result = evaluateJob(
        profile({ commute: [] }),
        job({ workMode: 'presencial', location }),
      );
      expect(get(result.criteria, 'localizacao')?.outcome).toBe('indeterminado');
      expect(get(result.criteria, 'localizacao')?.detail).toContain('região metropolitana');
      expect(result.verdict).toBe('revisao_humana');
    }
  });

  it('com o tempo confirmado de uma cidade metropolitana, a regra de minutos decide', () => {
    const p = profile({
      commute: [
        {
          keywords: ['osasco'],
          minutesPerWay: 65,
          source: 'Google Maps',
          confirmedAt: '2026-10-23',
        },
      ],
    });
    const result = evaluateJob(p, job({ workMode: 'presencial', location: 'Osasco, SP' }));
    expect(get(result.criteria, 'localizacao')?.outcome).toBe('atende');
    expect(get(result.criteria, 'deslocamento')?.outcome).toBe('atende');
    const slow = profile({
      commute: [{ keywords: ['osasco'], minutesPerWay: 95, source: 'Google Maps' }],
    });
    expect(evaluateJob(slow, job({ workMode: 'presencial', location: 'Osasco, SP' })).verdict).toBe(
      'inapto',
    );
  });

  it('presencial ou híbrido em outra cidade do estado continua incompatível', () => {
    const result = evaluateJob(profile(), job({ workMode: 'hibrido', location: 'Campinas, SP' }));
    expect(get(result.criteria, 'localizacao')?.outcome).toBe('nao_atende');
  });
});

describe('remoto no Brasil', () => {
  const remote = (over = {}) =>
    evaluateJob(profile(), job({ workMode: 'remoto', location: 'Brasil', ...over }));

  it('remoto de qualquer região do Brasil vale', () => {
    for (const location of ['Brasil', 'Curitiba, PR (Remoto)', 'Remoto - Recife'])
      expect(get(remote({ location }).criteria, 'localizacao')?.outcome).toBe('atende');
  });

  it('exigência de residir fora de São Paulo vira pendência', () => {
    const result = remote({ description: 'Requisito: residir em Curitiba ou região.' });
    expect(get(result.criteria, 'localizacao')?.outcome).toBe('indeterminado');
    expect(get(result.criteria, 'localizacao')?.detail).toContain('residência');
    expect(result.verdict).toBe('revisao_humana');
  });

  it('residência em São Paulo ou "todo o Brasil" não restringe', () => {
    for (const description of [
      'Desejável residir em São Paulo.',
      'Pode morar em qualquer lugar do Brasil.',
    ])
      expect(get(remote({ description }).criteria, 'localizacao')?.outcome).toBe('atende');
  });

  it('remoto fora do Brasil continua pendente', () => {
    expect(get(remote({ location: 'United States' }).criteria, 'localizacao')?.outcome).toBe(
      'indeterminado',
    );
  });
});
