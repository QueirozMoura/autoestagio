import { describe, expect, it } from 'vitest';
import { rankCandidates, rankKeys, type RankInput } from '../../src/eligibility/ranking.js';
import type { Criterion } from '../../src/eligibility/index.js';
import { formatCandidates } from '../../src/cli/preparation.js';

const c = (
  id: string,
  outcome: Criterion['outcome'],
  detail = 'd',
  kind: Criterion['kind'] = 'obrigatorio',
): Criterion => ({ id, outcome, detail, kind }) as Criterion;
const base = (over: Partial<RankInput> & { jobId: number }): RankInput => ({
  verdict: 'apto',
  criteria: [
    c('modalidade', 'atende'),
    c('localizacao', 'atende'),
    c('deslocamento', 'atende'),
    c('bolsa', 'atende'),
  ],
  differentialsMatched: 0,
  differentialsTotal: 0,
  firstSeenAt: '2026-10-20T00:00:00Z',
  ...over,
});
const order = (items: RankInput[]): number[] => rankCandidates(items).map((r) => r.item.jobId);

describe('ranking transparente', () => {
  it('1) elegibilidade: apta antes de revisão humana, mesmo com tudo o mais pior', () => {
    expect(
      order([
        base({ jobId: 1, verdict: 'revisao_humana' }),
        base({
          jobId: 2,
          firstSeenAt: '2020-01-01T00:00:00Z',
          criteria: [c('bolsa', 'indeterminado')],
        }),
      ]),
    ).toEqual([2, 1]);
  });

  it('2) deslocamento: viável > pendente > limítrofe', () => {
    const viable = base({ jobId: 1 });
    const pending = base({
      jobId: 2,
      criteria: [
        c('deslocamento', 'indeterminado', 'Deslocamento não verificável'),
        c('bolsa', 'atende'),
      ],
    });
    const edge = base({
      jobId: 3,
      criteria: [
        c('deslocamento', 'indeterminado', 'Deslocamento limítrofe: 75 min'),
        c('bolsa', 'atende'),
      ],
    });
    expect(order([edge, pending, viable])).toEqual([1, 2, 3]);
    const remote = base({
      jobId: 4,
      criteria: [c('modalidade', 'atende'), c('localizacao', 'atende'), c('bolsa', 'atende')],
    });
    expect(rankKeys(remote).keys.commute).toBe(0);
  });

  it('3) bolsa: conhecida ≥ mínimo antes de desconhecida', () => {
    const known = base({ jobId: 1 });
    const unknown = base({
      jobId: 2,
      criteria: [c('deslocamento', 'atende'), c('bolsa', 'indeterminado')],
    });
    expect(order([unknown, known])).toEqual([1, 2]);
  });

  it('4) requisitos: menos pendências obrigatórias primeiro; 5) diferenciais: maior fração primeiro', () => {
    const few = base({ jobId: 1 });
    const many = base({
      jobId: 2,
      criteria: [
        ...base({ jobId: 0 }).criteria,
        c('idioma', 'indeterminado'),
        c('curso', 'indeterminado'),
      ],
    });
    expect(order([many, few])).toEqual([1, 2]);
    const low = base({ jobId: 3, differentialsMatched: 1, differentialsTotal: 4 });
    const high = base({ jobId: 4, differentialsMatched: 3, differentialsTotal: 4 });
    expect(order([low, high])).toEqual([4, 3]);
  });

  it('6) recência, e o número da vaga como desempate final; formato SQLite de data também vale', () => {
    expect(
      order([
        base({ jobId: 1, firstSeenAt: '2026-10-01T00:00:00Z' }),
        base({ jobId: 2, firstSeenAt: '2026-10-22T00:00:00Z' }),
      ]),
    ).toEqual([2, 1]);
    expect(order([base({ jobId: 5 }), base({ jobId: 3 })])).toEqual([3, 5]);
    expect(rankKeys(base({ jobId: 1, firstSeenAt: '2026-10-22 12:00:00' })).keys.recencyMs).toBe(
      Date.parse('2026-10-22T12:00:00Z'),
    );
  });

  it('a área da vaga não influencia a ordem: títulos de qualquer área empatam pelos mesmos critérios', () => {
    const items = ['Suporte', 'QA', 'Dados', 'Segurança', 'Desenvolvimento'].map((_, i) =>
      base({ jobId: i + 1 }),
    );
    expect(order(items)).toEqual([1, 2, 3, 4, 5]);
    expect(Object.keys(rankKeys(items[0] as RankInput).keys)).not.toContain('area');
  });

  it('--explain mostra as seis chaves de cada vaga, sem inventar dados', () => {
    const ranked = rankCandidates([
      base({ jobId: 7, differentialsMatched: 1, differentialsTotal: 2 }),
    ]);
    const text = formatCandidates(
      ranked.map((r) => ({
        jobId: r.item.jobId,
        title: 'T',
        company: 'C',
        verdict: r.item.verdict,
        position: r.position,
        explanation: r.explanation,
      })),
      true,
    );
    expect(text).toContain('1. elegibilidade: apta');
    expect(text).toContain('2. deslocamento viável');
    expect(text).toContain('3. bolsa: conhecida e acima do mínimo');
    expect(text).toContain('5. diferenciais atendidos: 1/2');
    expect(text).toContain('coletada em 2026-10-20');
    expect(
      formatCandidates([
        { jobId: 7, title: 'T', company: 'C', verdict: 'apto', position: 1, explanation: ['x'] },
      ]),
    ).not.toContain('x');
  });
});
