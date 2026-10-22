import { beforeAll, describe, expect, it } from 'vitest';
import { detectClaims, type CvMaster } from '../../src/cv/index.js';
import { loadFictional, type Loaded } from '../helpers/cv-fixture.js';

let L: Loaded;
beforeAll(async () => {
  L = await loadFictional();
});
const kinds = (model: CvMaster) => {
  const counts: Record<string, number> = {};
  for (const c of detectClaims(model).claims) counts[c.kind] = (counts[c.kind] ?? 0) + 1;
  return counts;
};

describe('afirmações que exigem confirmação', () => {
  it('toda afirmação nasce pendente, com citação exata e uma pergunta', () => {
    const { claims } = detectClaims(L.model);
    expect(claims.length).toBeGreaterThan(10);
    for (const c of claims) {
      expect(c.status).toBe('pendente');
      expect(c.quote.length).toBeGreaterThan(0);
      expect(c.question).toMatch(/\?/);
    }
    expect(new Set(claims.map((c) => c.id)).size).toBe(claims.length);
  });

  it('números de usuários: um por trecho, inclusive o do resumo', () => {
    const users = detectClaims(L.model).claims.filter((c) => c.kind === 'numero_usuarios');
    expect(users.map((c) => c.quote)).toEqual([
      'usados por cerca de 90 pessoas',
      'usada em média por 40 pessoas',
      'usada em média por 50 pessoas',
    ]);
  });

  it('soma dos usuários dos sistemas × resumo: sem inconsistência quando fecha, com ela quando não', () => {
    expect(detectClaims(L.model).inconsistencies.some((i) => /resumo diz/.test(i))).toBe(false); // 40 + 50 = 90
    const other = structuredClone(L.model);
    const bullet = other.experience[1]?.bullets[0]?.variants[0];
    if (bullet) bullet.text = bullet.text.replace('por 50 pessoas', 'por 70 pessoas');
    const found = detectClaims(other).inconsistencies.find((i) => /resumo diz/.test(i));
    expect(found).toMatch(/cerca de 90.*40 \+ 70 = 110/);
  });

  it('"mais de N testes" cujas partes somam exatamente N é apontado como inconsistente', () => {
    const { claims, inconsistencies } = detectClaims(L.model);
    expect(claims.find((c) => c.kind === 'numero_testes')?.quote).toMatch(
      /mais de 600 testes automatizados \(300 no frontend e 300 no backend\)/,
    );
    expect(inconsistencies.join(' ')).toMatch(/300 \+ 300 = 600, o que não é "mais de 600"/);
    expect(
      claims.some(
        (c) => c.kind === 'inconsistencia' && c.question.includes('Qual texto devo usar?'),
      ),
    ).toBe(true);

    const fine = structuredClone(L.model);
    const text = fine.projects[0]?.bullets[1]?.variants[0];
    if (text) text.text = text.text.replace('mais de 600', 'mais de 500');
    expect(detectClaims(fine).inconsistencies.join(' ')).not.toMatch(/mais de 500/);
    if (text)
      text.text = text.text.replace(
        'mais de 500 testes automatizados (300 no frontend e 300 no backend)',
        '650 testes automatizados (300 no frontend e 300 no backend)',
      );
    expect(detectClaims(fine).inconsistencies.join(' ')).toMatch(/somam 600, não 650/);
  });

  it('produção comercial, técnicas específicas, estado atual, certificação, formação e estrutura', () => {
    const c = kinds(L.model);
    expect(c.producao_comercial).toBeGreaterThanOrEqual(2);
    expect(c.tecnica_especifica).toBeGreaterThanOrEqual(2);
    expect(c.estado_atual).toBe(1); // "mantenho"
    expect(c.certificacao).toBe(1);
    expect(c.periodo_formacao).toBe(1); // só a formação "cursando"
    expect(c.estrutura).toBe(2); // dois projetos listados sob "Experiência profissional"
  });

  it('link terminado em hífen recebe a pergunta específica e nada é corrigido', () => {
    const links = detectClaims(L.model).claims.filter((c) => c.kind === 'link');
    expect(links).toHaveLength(8);
    const hyphen = links.filter((c) => /termina com hífen/.test(c.question));
    expect(hyphen.map((c) => c.quote)).toEqual(
      expect.arrayContaining([
        expect.stringContaining('maria-exemplo-'),
        expect.stringContaining('oficina-'),
      ]),
    );
    expect(hyphen.every((c) => /nada foi corrigido/.test(c.question))).toBe(true);
    expect(L.model.identity.links[0]?.url).toBe('https://www.example.com/in/maria-exemplo-');
  });

  it('é só detecção: não altera o modelo e é determinística', () => {
    const before = JSON.stringify(L.model);
    const a = detectClaims(L.model);
    expect(JSON.stringify(L.model)).toBe(before);
    expect(detectClaims(L.model)).toEqual(a);
  });
});
