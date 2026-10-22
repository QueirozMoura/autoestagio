import type { PdfExtraction } from './pdf.js';
import { joinLines, normalizeText } from './parse.js';
import type { CvMaster, SectionId } from './schema.js';

export interface TextUnit {
  id: string;
  section: SectionId;
  text: string;
}

/** Variantes que vêm do PDF. As `editada`s são texto seu, revisado: o PDF não as confere. */
const fromPdf = <V extends { origin: string }>(variants: V[]): V[] =>
  variants.filter((v) => v.origin === 'mestre');

/** Todos os textos do PDF no modelo, na ordem em que aparecem no documento. */
export function modelTexts(model: CvMaster): TextUnit[] {
  const out: TextUnit[] = [
    { id: 'identity-name', section: 'cabecalho', text: model.identity.name.value },
  ];
  for (const v of fromPdf(model.identity.headline.variants))
    out.push({ id: v.id, section: 'cabecalho', text: v.text });
  out.push({ id: 'identity-location', section: 'cabecalho', text: model.identity.location.value });
  for (const c of model.identity.contacts)
    out.push({ id: `contact-${c.id}`, section: 'cabecalho', text: c.value });
  for (const l of model.identity.links) out.push({ id: l.id, section: 'cabecalho', text: l.label });
  for (const v of fromPdf(model.summary.variants))
    out.push({ id: v.id, section: 'resumo', text: v.text });
  for (const [section, list] of [
    ['experiencia', model.experience],
    ['projetos', model.projects],
  ] as const) {
    for (const entry of list) {
      out.push({ id: entry.id, section, text: entry.title });
      if (entry.period !== undefined)
        out.push({ id: `${entry.id}-period`, section, text: entry.period.label });
      for (const b of entry.bullets)
        for (const v of fromPdf(b.variants)) out.push({ id: v.id, section, text: v.text });
      if (entry.technologies.length > 0)
        out.push({ id: `${entry.id}-techs`, section, text: entry.technologies.join(', ') });
      for (const l of entry.links) out.push({ id: l.id, section, text: l.label });
    }
  }
  for (const s of model.skills) out.push({ id: s.id, section: 'skills', text: s.text });
  for (const e of model.education) out.push({ id: e.id, section: 'educacao', text: e.text });
  for (const l of model.languages) out.push({ id: l.id, section: 'idiomas', text: l.text });
  for (const c of model.certifications)
    out.push({ id: c.id, section: 'certificacoes', text: c.text });
  return out;
}

const squash = (value: string): string =>
  value
    .normalize('NFKC')
    .replace(/[\s|]+/g, '')
    .toLowerCase();

/** Rótulos que são estrutura do documento (não conteúdo): aparecem no PDF e não no modelo. */
const STRUCTURAL_TOKENS = new Set(['tecnologias:', 'links:', '•', '|', '—', '–', '-']);

function tokens(value: string): string[] {
  return value
    .normalize('NFC')
    .split(/\s+/)
    .map((t) => t.replace(/^[|•]+|[|•]+$/g, '').toLowerCase())
    .filter((t) => t !== '' && !STRUCTURAL_TOKENS.has(t));
}

function diffBags(a: string[], b: string[]): { token: string; count: number }[] {
  const bag = new Map<string, number>();
  for (const t of b) bag.set(t, (bag.get(t) ?? 0) + 1);
  const extra = new Map<string, number>();
  for (const t of a) {
    const left = bag.get(t) ?? 0;
    if (left > 0) bag.set(t, left - 1);
    else extra.set(t, (extra.get(t) ?? 0) + 1);
  }
  return [...extra].map(([token, count]) => ({ token, count }));
}

const numbersIn = (value: string): string[] => value.match(/\d[\d.,]*\d|\d/g) ?? [];

export interface FidelityReport {
  verdict: 'fiel' | 'divergente';
  masterSha256: { model: string; file: string; matches: boolean };
  blocks: { total: number; found: number; missing: { id: string; section: SectionId }[] };
  bySection: { section: SectionId; total: number; found: number }[];
  /** No PDF e fora do modelo (omissões) e no modelo e fora do PDF (invenções), sem os rótulos estruturais. */
  omittedFromModel: { token: string; count: number }[];
  notInPdf: { token: string; count: number }[];
  numbers: { inPdfNotModel: string[]; inModelNotPdf: string[] };
  order: { inOrder: number; total: number };
  links: { inPdf: number; inModel: number; matching: number; mismatches: string[] };
  derivedFields: { checked: number; invalid: string[] };
  /** Conferência com um segundo extrator de texto (opcional). */
  crossCheck?: {
    extractor: string;
    found: number;
    total: number;
    missing: string[];
    explained: string[];
  };
}

export function fidelityReport(
  model: CvMaster,
  extraction: PdfExtraction,
  crossCheck?: { extractor: string; text: string },
): FidelityReport {
  const units = modelTexts(model);
  const pdfText = extraction.lines.map((l) => l.text).join('\n');
  const pdfSquash = squash(pdfText);

  const missing = units.filter((u) => !pdfSquash.includes(squash(u.text)));
  const sections = [...new Set(units.map((u) => u.section))];
  const bySection = sections.map((section) => {
    const list = units.filter((u) => u.section === section);
    return {
      section,
      total: list.length,
      found: list.filter((u) => pdfSquash.includes(squash(u.text))).length,
    };
  });

  // Palavras: o PDF (sem títulos de seção) contra o conteúdo do modelo.
  // As 3 primeiras linhas são o cabeçalho (o nome também é maiúsculo e em negrito: não é título de seção).
  const bodyLines = extraction.lines.filter(
    (l, i) =>
      i < 3 || !(l.allBold && l.text === l.text.toUpperCase() && /[A-ZÀ-Ú]{3}/.test(l.text)),
  );
  const pdfTokens = tokens(joinLines(bodyLines));
  const modelTokens = tokens(units.map((u) => u.text).join(' '));
  const omitted = diffBags(pdfTokens, modelTokens);
  const invented = diffBags(modelTokens, pdfTokens);

  const pdfNumbers = numbersIn(pdfText);
  const modelNumbers = numbersIn(units.map((u) => u.text).join(' '));
  const numberDiff = {
    inPdfNotModel: diffBags(pdfNumbers, modelNumbers).map((d) => d.token),
    inModelNotPdf: diffBags(modelNumbers, pdfNumbers).map((d) => d.token),
  };

  // Ordem: cada texto precisa aparecer no PDF depois do anterior.
  let pointer = 0;
  let inOrder = 0;
  for (const unit of units) {
    const position = pdfSquash.indexOf(squash(unit.text), pointer);
    if (position >= 0) {
      inOrder += 1;
      pointer = position + squash(unit.text).length;
    }
  }

  // Links: anotações do PDF × links do modelo (mesma ordem, mesmo URL e rótulo).
  const modelLinks = [
    ...model.identity.links,
    ...model.experience.flatMap((e) => e.links),
    ...model.projects.flatMap((e) => e.links),
  ];
  const linkMismatches: string[] = [];
  let matching = 0;
  modelLinks.forEach((link, i) => {
    const pdfLink = extraction.links[i];
    if (
      pdfLink !== undefined &&
      pdfLink.url === link.url &&
      normalizeText(pdfLink.label) === normalizeText(link.label)
    )
      matching += 1;
    else
      linkMismatches.push(
        `${link.id}: modelo "${link.label}" ${link.url} × PDF ${pdfLink === undefined ? 'ausente' : `"${pdfLink.label}" ${pdfLink.url}`}`,
      );
  });

  // Campos derivados precisam ser subtrechos exatos do texto de onde saíram.
  const invalid: string[] = [];
  let checked = 0;
  const expect = (ok: boolean, what: string): void => {
    checked += 1;
    if (!ok) invalid.push(what);
  };
  for (const entry of [...model.experience, ...model.projects]) {
    if (entry.organization !== undefined && entry.role !== undefined)
      expect(
        `${entry.organization} — ${entry.role}` === entry.title,
        `${entry.id}: organização/cargo`,
      );
    for (const tech of entry.technologies)
      expect(pdfSquash.includes(squash(tech)), `${entry.id}: tecnologia "${tech}"`);
  }
  for (const s of model.skills)
    for (const item of s.items)
      expect(squash(s.text).includes(squash(item)), `${s.id}: item "${item}"`);
  for (const e of model.education)
    expect(
      e.text.includes(e.course) && e.text.includes(e.institution) && e.text.includes(e.statusLabel),
      `${e.id}: partes da formação`,
    );
  for (const c of model.certifications)
    expect(
      c.text.includes(c.title) && c.text.includes(c.issuer) && c.text.includes(String(c.year)),
      `${c.id}: partes da certificação`,
    );

  const masterMatches = model.master.sha256 === extraction.sha256;
  const verdict =
    masterMatches &&
    missing.length === 0 &&
    omitted.length === 0 &&
    invented.length === 0 &&
    numberDiff.inPdfNotModel.length === 0 &&
    numberDiff.inModelNotPdf.length === 0 &&
    inOrder === units.length &&
    linkMismatches.length === 0 &&
    modelLinks.length === extraction.links.length &&
    invalid.length === 0
      ? 'fiel'
      : 'divergente';

  let cross: FidelityReport['crossCheck'];
  if (crossCheck !== undefined) {
    const other = squash(crossCheck.text);
    const lost = units.filter((u) => !other.includes(squash(u.text)));
    // Alguns extratores (Poppler) unem palavras quebradas no hífen ("e-" + "commerce" → "ecommerce").
    const explained = lost.filter((u) => other.includes(squash(u.text).replaceAll('-', '')));
    cross = {
      extractor: crossCheck.extractor,
      found: units.length - lost.length + explained.length,
      total: units.length,
      missing: lost.filter((u) => !explained.includes(u)).map((u) => u.id),
      explained: explained.map((u) => u.id),
    };
  }

  return {
    verdict,
    masterSha256: { model: model.master.sha256, file: extraction.sha256, matches: masterMatches },
    blocks: {
      total: units.length,
      found: units.length - missing.length,
      missing: missing.map((u) => ({ id: u.id, section: u.section })),
    },
    bySection,
    omittedFromModel: omitted,
    notInPdf: invented,
    numbers: numberDiff,
    order: { inOrder, total: units.length },
    links: {
      inPdf: extraction.links.length,
      inModel: modelLinks.length,
      matching,
      mismatches: linkMismatches,
    },
    derivedFields: { checked, invalid },
    ...(cross === undefined ? {} : { crossCheck: cross }),
  };
}
