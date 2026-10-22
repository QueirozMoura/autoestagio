import { beforeAll, describe, expect, it } from 'vitest';
import {
  buildProposals,
  verifyProposals,
  enrichModel,
  type CvMaster,
  type Proposal,
} from '../../src/cv/index.js';
import { loadFictional, type Loaded } from '../helpers/cv-fixture.js';

let L: Loaded;
let set: ReturnType<typeof buildProposals>;
beforeAll(async () => {
  L = await loadFictional();
  set = buildProposals(L.model);
});

const byId = (id: string): Proposal | undefined => set.items.find((p) => p.id === id);

describe('propostas de variantes e destaques (nenhuma é aprovada)', () => {
  it('todas nascem "proposta", sem aprovação, e passam na verificação de procedência', () => {
    expect(set.items.length).toBeGreaterThan(3);
    for (const p of set.items) expect(p.status).toBe('proposta');
    expect(verifyProposals(L.model, set.items)).toEqual([]);
    expect(JSON.stringify(set)).not.toMatch(/approvedAt|aprovado/);
  });

  it('desenvolvimento: o resumo original, sem nenhuma alteração', () => {
    const p = byId('prop-resumo-desenvolvimento-verbatim');
    expect(p?.text).toBe(L.model.summary.variants[0]?.text);
    expect(p?.composedFrom).toEqual([
      { blockId: 'resumo-mestre', fragment: L.model.summary.variants[0]?.text },
    ]);
  });

  it('cada trecho é cópia EXATA de um bloco do mestre e nenhuma palavra nova entra', () => {
    const texts = new Map<string, string>();
    for (const v of L.model.summary.variants) texts.set(v.id, v.text);
    for (const e of [...L.model.experience, ...L.model.projects])
      for (const b of e.bullets) for (const v of b.variants) texts.set(v.id, v.text);
    const masterWords = new Set(
      (
        [...texts.values()]
          .join(' ')
          .toLowerCase()
          .match(/[\p{L}\p{N}][\p{L}\p{N}.+#/_-]*/gu) ?? []
      ).map((w) => w.replace(/\.+$/, '')),
    );
    for (const p of set.items) {
      for (const part of p.composedFrom) expect(texts.get(part.blockId)).toContain(part.fragment);
      const words = (p.text.toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}.+#/_-]*/gu) ?? []).map(
        (w) => w.replace(/\.+$/, ''),
      );
      expect(words.filter((w) => !masterWords.has(w))).toEqual([]);
    }
  });

  it('variantes "sem-numeros" não carregam números de usuários nem de testes', () => {
    for (const p of set.items.filter((i) => i.variant === 'sem-numeros')) {
      expect(p.text).not.toMatch(/\d[\d.]*\s+(?:pessoas|usuários|clientes|testes)|mais\s+de\s+\d/i);
    }
  });

  it('variantes "com-numeros" são marcadas para confirmação', () => {
    const withNumbers = set.items.filter((i) => i.variant === 'com-numeros');
    for (const p of withNumbers)
      expect(p.flags.join(' ')).toMatch(/números que dependem da sua confirmação/);
  });

  it('áreas sem evidência no currículo NÃO recebem proposta, com o motivo explicado', () => {
    expect(set.items.some((p) => p.area === 'suporte' || p.area === 'dados')).toBe(false);
    const reasons = Object.fromEntries(set.notProposed.map((n) => [n.area, n.reason]));
    expect(reasons.suporte).toMatch(/Sem evidência suficiente.*Nada foi inventado/);
    expect(reasons.dados).toMatch(/Sem evidência suficiente/);
  });

  it('destaques por entrada: até 300 caracteres, feitos só com trechos da própria entrada', () => {
    const highlights = set.items.filter((p) => p.kind === 'destaque');
    expect(new Set(highlights.map((h) => h.projectId))).toEqual(
      new Set(['exp-oficina-exemplo-ltda', 'exp-agendamais', 'proj-notasfacil']),
    );
    for (const h of highlights) {
      expect(h.text.length).toBeLessThanOrEqual(300);
      const entry = [...L.model.experience, ...L.model.projects].find((e) => e.id === h.projectId);
      const own = new Set(entry?.bullets.flatMap((b) => b.variants.map((v) => v.id)));
      expect(h.composedFrom.every((c) => own.has(c.blockId))).toBe(true);
    }
  });

  it('é determinística e não altera o modelo', () => {
    const before = JSON.stringify(L.model);
    expect(buildProposals(L.model)).toEqual(set);
    expect(JSON.stringify(L.model)).toBe(before);
  });

  it('enrichModel guarda as propostas fora do currículo e todas as afirmações como pendentes', () => {
    const enriched = enrichModel(L.model);
    expect(enriched.proposals.items.length).toBe(set.items.length);
    expect(enriched.claims.every((c) => c.status === 'pendente')).toBe(true);
    expect(enriched.summary).toEqual(L.model.summary); // a seção do currículo não muda
    expect(enriched.approval).toBeUndefined();
  });

  describe('verificação de procedência (detecta adulteração)', () => {
    const first = (): Proposal => {
      const p = set.items.find((i) => i.variant === 'sem-numeros' && i.kind === 'resumo');
      if (!p) throw new Error('sem proposta de resumo');
      return structuredClone(p);
    };

    it('palavra nova, trecho que não está no bloco, bloco inexistente e texto que não é a junção', () => {
      const withWord = first();
      withWord.text = `${withWord.text.slice(0, -1)} Kubernetes.`;
      expect(verifyProposals(L.model, [withWord]).join(' ')).toMatch(
        /não é a junção|palavras que não estão/,
      );

      const wrongFragment = first();
      wrongFragment.composedFrom[0] = {
        blockId: wrongFragment.composedFrom[0]?.blockId ?? '',
        fragment: 'frase que não existe no currículo',
      };
      expect(verifyProposals(L.model, [wrongFragment]).join(' ')).toMatch(/não é cópia exata/);

      const missingBlock = first();
      missingBlock.composedFrom[0] = { blockId: 'nao-existe', fragment: 'x' };
      expect(verifyProposals(L.model, [missingBlock]).join(' ')).toMatch(/não existe no modelo/);

      const tooLong = { ...first(), kind: 'destaque' as const, text: 'x'.repeat(301) };
      expect(verifyProposals(L.model, [tooLong]).join(' ')).toMatch(/passa de 300/);
    });
  });

  it('currículo sem evidência de nenhuma área técnica: nada é proposto além do original', () => {
    const bare: CvMaster = structuredClone(L.model);
    for (const e of [...bare.experience, ...bare.projects]) {
      for (const b of e.bullets)
        for (const v of b.variants) v.text = 'Organizei documentos e planilhas da equipe.';
    }
    const out = buildProposals(bare);
    expect(out.items.filter((p) => p.kind === 'resumo').map((p) => p.variant)).toEqual([
      'verbatim',
    ]);
    expect(out.notProposed.map((n) => n.area).sort()).toEqual([
      'banco-de-dados',
      'dados',
      'infraestrutura',
      'qa',
      'suporte',
    ]);
  });
});
