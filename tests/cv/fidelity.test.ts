import { beforeAll, describe, expect, it } from 'vitest';
import { fidelityReport, modelTexts, type CvMaster } from '../../src/cv/index.js';
import { loadFictional, type Loaded } from '../helpers/cv-fixture.js';

let L: Loaded;
beforeAll(async () => {
  L = await loadFictional();
});
const mutate = (fn: (m: CvMaster) => void): CvMaster => {
  const copy = structuredClone(L.model);
  fn(copy);
  return copy;
};
const report = (model: CvMaster) => fidelityReport(model, L.extraction);

describe('relatório de fidelidade (modelo × PDF mestre)', () => {
  it('modelo fiel: tudo encontrado, na ordem, sem omissões nem invenções, links idênticos', () => {
    const r = report(L.model);
    expect(r.verdict).toBe('fiel');
    expect(r.masterSha256).toEqual({
      model: L.extraction.sha256,
      file: L.extraction.sha256,
      matches: true,
    });
    expect(r.blocks).toMatchObject({
      total: modelTexts(L.model).length,
      found: modelTexts(L.model).length,
      missing: [],
    });
    expect(r.order).toEqual({ inOrder: r.blocks.total, total: r.blocks.total });
    expect(r.omittedFromModel).toEqual([]);
    expect(r.notInPdf).toEqual([]);
    expect(r.numbers).toEqual({ inPdfNotModel: [], inModelNotPdf: [] });
    expect(r.links).toMatchObject({ inPdf: 8, inModel: 8, matching: 8, mismatches: [] });
    expect(r.derivedFields.invalid).toEqual([]);
    expect(r.derivedFields.checked).toBeGreaterThan(20);
    expect(r.bySection.every((s) => s.found === s.total)).toBe(true);
  });

  it('texto do modelo alterado: o bloco some do PDF e o veredito vira divergente', () => {
    const model = mutate((m) => {
      const v = m.experience[0]?.bullets[0]?.variants[0];
      if (v)
        v.text = v.text.replace('usada em média por 40 pessoas', 'usada em média por 400 pessoas');
    });
    const r = report(model);
    expect(r.verdict).toBe('divergente');
    expect(r.blocks.missing.map((m) => m.id)).toContain('exp-oficina-exemplo-ltda-b1-mestre');
    expect(r.numbers.inModelNotPdf).toContain('400');
    expect(r.numbers.inPdfNotModel).toContain('40');
  });

  it('tecnologia inventada: aparece como palavra fora do PDF e como campo derivado inválido', () => {
    const model = mutate((m) => {
      m.experience[0]?.technologies.push('Kubernetes');
    });
    const r = report(model);
    expect(r.verdict).toBe('divergente');
    expect(r.notInPdf.map((d) => d.token)).toContain('kubernetes');
    expect(r.derivedFields.invalid.join(' ')).toMatch(/Kubernetes/);
  });

  it('bloco omitido do modelo: as palavras dele aparecem como omissão', () => {
    const model = mutate((m) => {
      m.experience[1]?.bullets.pop();
    });
    const r = report(model);
    expect(r.verdict).toBe('divergente');
    expect(r.omittedFromModel.map((d) => d.token)).toEqual(
      expect.arrayContaining(['impedi', 'agendamentos']),
    );
  });

  it('link diferente do PDF, link a mais e SHA do mestre diferente são detectados', () => {
    const swapped = mutate((m) => {
      const link = m.identity.links[0];
      if (link) link.url = 'https://www.example.com/outro-perfil';
    });
    expect(report(swapped).links.mismatches[0]).toMatch(/link-linkedin/);
    expect(report(swapped).verdict).toBe('divergente');

    const otherMaster = mutate((m) => {
      m.master.sha256 = 'e'.repeat(64);
    });
    expect(report(otherMaster)).toMatchObject({
      verdict: 'divergente',
      masterSha256: { matches: false },
    });
  });

  it('ordem trocada no modelo é detectada', () => {
    const model = mutate((m) => {
      m.experience.reverse();
    });
    const r = report(model);
    expect(r.order.inOrder).toBeLessThan(r.order.total);
    expect(r.verdict).toBe('divergente');
  });

  it('segundo extrator: aceita, e explica a divergência de hífen em quebra de linha', () => {
    const text = L.extraction.lines.map((l) => l.text).join('\n');
    const ok = fidelityReport(L.model, L.extraction, { extractor: 'extrator-b', text });
    expect(ok.crossCheck).toMatchObject({
      found: ok.blocks.total,
      total: ok.blocks.total,
      missing: [],
      explained: [],
    });

    const dehyphenated = fidelityReport(L.model, L.extraction, {
      extractor: 'extrator-b',
      text: text.replace('e-\n', 'e').replace('commerce', 'commerce'),
    });
    expect(dehyphenated.crossCheck?.explained).toEqual(['exp-oficina-exemplo-ltda-b1-mestre']);
    expect(dehyphenated.crossCheck?.missing).toEqual([]);

    const broken = fidelityReport(L.model, L.extraction, {
      extractor: 'extrator-b',
      text: 'texto sem nada',
    });
    expect(broken.crossCheck?.missing.length).toBe(broken.blocks.total);
  });
});
