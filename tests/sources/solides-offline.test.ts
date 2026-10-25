import { describe, expect, it } from 'vitest';
import { parseSolidesSample } from '../../src/sources/solides-offline.js';
import { createDefaultRegistry, parseSourcesConfig } from '../../src/sources/index.js';

// Todos os registros são sintéticos; nenhuma coleta foi feita para construir estes testes.
const sample = (data: unknown[]) => ({ count: data.length, currentPage: 1, totalPages: 2, data });
const internship = { id: 123, title: 'Estágio em TI', company: 'Empresa Fictícia' };

describe('Sólides: adaptação exclusivamente offline', () => {
  it('adapta uma amostra sem disponibilizar coleta recorrente', () => {
    const result = parseSolidesSample(
      sample([internship, { id: 2, title: 'Analista Sênior' }, {}]),
    );
    expect(result).toMatchObject({ invalid: 1, filtered: 1, hasMore: true });
    expect(result.jobs).toHaveLength(1);
    expect(result.jobs[0]).toMatchObject({
      externalId: '123',
      url: 'https://vagas.solides.com.br/vaga/123',
    });
    expect(createDefaultRegistry().kinds()).toEqual(['ashby', 'greenhouse', 'lever']);
    expect(() =>
      parseSourcesConfig({ targets: [{ kind: 'solides', slug: 'x', name: 'X' }] }),
    ).toThrow();
  });

  it('não transforma zero em mínimo de bolsa nem supõe modalidade', () => {
    const result = parseSolidesSample(
      sample([{ ...internship, homeOffice: false, salary: { min: 0, max: 1800 } }]),
    );
    expect(result.jobs[0]?.workMode).toBeUndefined();
    expect(result.jobs[0]?.compensationText).toContain('mínimo não informado');
    expect(result.jobs[0]?.compensationText).not.toContain('R$ 0');
    expect(
      parseSolidesSample(sample([{ ...internship, salary: { min: 0, max: 0 } }])).jobs[0]
        ?.compensationText,
    ).toBeUndefined();
  });

  it('preserva restrições afirmativas e trata sinais conflitantes como desconhecidos', () => {
    const result = parseSolidesSample(
      sample([
        {
          ...internship,
          jobType: 'hibrido',
          homeOffice: true,
          pcdOnly: true,
          affirmative: 'mulheres',
        },
      ]),
    );
    expect(result.jobs[0]?.workMode).toBeUndefined();
    expect(result.jobs[0]?.description).toContain('Vaga afirmativa: mulheres');
    expect(result.jobs[0]?.description).toContain('exclusiva');
    expect(
      parseSolidesSample(sample([{ ...internship, jobType: 'remoto' }])).jobs[0]?.workMode,
    ).toBe('remoto');
  });

  it('rejeita envelopes inválidos', () => {
    expect(() => parseSolidesSample({ data: [] })).toThrow();
  });
});
