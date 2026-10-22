import {
  cvMasterSchema,
  sha256Text,
  type CvLink,
  type CvMaster,
  type Entry,
  type SectionId,
  type SourceRef,
  type VariantBlock,
} from './schema.js';
import type { PdfExtraction, PdfLine } from './pdf.js';

export class CvParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CvParseError';
  }
}

export interface ParseResult {
  model: CvMaster;
  /** Suposições e pontos de atenção da leitura (nunca mudam o texto). */
  notes: string[];
}

export const normalizeText = (value: string): string =>
  value.normalize('NFC').replace(/\s+/g, ' ').trim();

export function slugify(value: string, max = 40): string {
  const slug = value
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max)
    .replace(/-+$/g, '');
  return slug.length >= 2 ? slug : `x${slug}`;
}

/**
 * Junta linhas de um mesmo parágrafo. Linha que termina em hífen e continua em minúscula é uma
 * palavra composta quebrada no hífen ("e-" + "commerce" → "e-commerce"): sem espaço extra.
 */
export function joinLines(lines: readonly PdfLine[]): string {
  let text = '';
  for (const line of lines) {
    if (text === '') text = line.text;
    else if (/[A-Za-zÀ-ÿ0-9]-$/.test(text) && /^[a-zà-ÿ]/.test(line.text)) text += line.text;
    else text += ` ${line.text}`;
  }
  return normalizeText(text);
}

/** Divide por vírgula respeitando parênteses ("Playwright (E2E, CI)" fica inteiro). */
export function splitList(value: string): string[] {
  const items: string[] = [];
  let depth = 0;
  let current = '';
  for (const char of value) {
    if (char === '(') depth += 1;
    if (char === ')') depth = Math.max(0, depth - 1);
    if (char === ',' && depth === 0) {
      items.push(current.trim());
      current = '';
    } else current += char;
  }
  if (current.trim() !== '') items.push(current.trim());
  return items.filter((item) => item !== '');
}

const HEADINGS: Record<string, SectionId> = {
  'RESUMO PROFISSIONAL': 'resumo',
  'EXPERIÊNCIA PROFISSIONAL': 'experiencia',
  'PROJETOS DE DESTAQUE': 'projetos',
  PROJETOS: 'projetos',
  'COMPETÊNCIAS TÉCNICAS (SKILLS)': 'skills',
  'COMPETÊNCIAS TÉCNICAS': 'skills',
  SKILLS: 'skills',
  EDUCAÇÃO: 'educacao',
  'FORMAÇÃO ACADÊMICA': 'educacao',
  'IDIOMAS E CERTIFICAÇÕES': 'idiomas',
  IDIOMAS: 'idiomas',
  CERTIFICAÇÕES: 'certificacoes',
};

const EMAIL = /^[^\s@|]+@[^\s@|]+\.[A-Za-z]{2,}$/;
const PHONE = /^\+?\(?\d{2}\)?[\s.-]?9?\d{4}[\s.-]?\d{4}$/;
const PERIOD = /^(.*?)\s*\|\s*((\d{4})(?:\s*[–-]\s*(\d{4}))?)$/;
const LANGUAGE_LINE = /^[A-ZÀ-Ú][A-Za-zÀ-ÿ]+:\s*(?:Nativo|Básico|Intermediário|Avançado|Fluente)/;
const CERTIFICATION = /^(.+?)\s+—\s+(.+?)\s+\((\d{4})\)(?::\s*(.+))?$/;

function ref(section: SectionId, lines: readonly PdfLine[], text: string): SourceRef {
  const first = lines[0];
  const last = lines[lines.length - 1];
  if (first === undefined || last === undefined) throw new CvParseError('trecho sem linhas');
  return {
    section,
    page: first.page,
    lines: [first.n, last.n],
    textSha256: sha256Text(normalizeText(text)),
  };
}

function variantBlock(
  blockId: string,
  section: SectionId,
  lines: readonly PdfLine[],
  text: string,
  required = false,
): VariantBlock {
  return {
    id: blockId,
    required,
    priority: 50,
    variants: [
      {
        id: `${blockId}-mestre`,
        text,
        areas: [],
        technologies: [],
        origin: 'mestre',
        basis: [],
        sourceRef: ref(section, lines, text),
        status: 'rascunho',
      },
    ],
  };
}

/**
 * Lê o PDF mestre (já extraído) e monta o modelo. Cada texto é cópia exata do PDF e traz a origem
 * (linhas e hash). NADA é aprovado: status "rascunho", links não confirmados, sem `approval`.
 * Linha que não se encaixa em nenhuma estrutura conhecida faz a leitura falhar (nada é descartado).
 */
export function parseMaster(extraction: PdfExtraction, options: { now?: Date } = {}): ParseResult {
  const notes: string[] = [];
  const lines = extraction.lines;
  const [nameLine, headlineLine, contactLine] = lines;
  if (nameLine === undefined || headlineLine === undefined || contactLine === undefined) {
    throw new CvParseError('o PDF não tem o cabeçalho esperado (nome, objetivo e contato)');
  }
  if (!contactLine.text.includes('@'))
    throw new CvParseError('a 3ª linha do PDF não parece ser a linha de contato');

  const linkQueue = [...extraction.links];
  const takeLink = (label: string, where: string): { url: string; page: number } => {
    const next = linkQueue.shift();
    if (next === undefined)
      throw new CvParseError(`o link "${label}" (${where}) não tem anotação correspondente no PDF`);
    if (normalizeText(next.label) !== normalizeText(label)) {
      notes.push(
        `Rótulo do link em ${where}: texto "${label}" × texto sob a anotação "${next.label}" (conferir).`,
      );
    }
    return { url: next.url, page: next.page };
  };

  // ---------------------------------------------------------------- cabeçalho
  const contacts: CvMaster['identity']['contacts'] = [];
  const identityLinks: CvLink[] = [];
  let location: { value: string; sourceRef: SourceRef } | undefined;
  for (const part of contactLine.text.split(/\s+\|\s+/).map((p) => p.trim())) {
    if (EMAIL.test(part))
      contacts.push({
        id: 'email',
        kind: 'email',
        value: part,
        sourceRef: ref('cabecalho', [contactLine], part),
      });
    else if (PHONE.test(part))
      contacts.push({
        id: 'telefone',
        kind: 'telefone',
        value: part,
        sourceRef: ref('cabecalho', [contactLine], part),
      });
    else if (/^(LinkedIn|GitHub|Portfólio|Portfolio|Site|Behance)$/i.test(part)) {
      const found = takeLink(part, 'cabeçalho');
      identityLinks.push({
        id: `link-${slugify(part)}`,
        label: part,
        url: found.url,
        page: found.page,
        confirmedByUser: false,
        status: 'rascunho',
      });
    } else if (location === undefined)
      location = { value: part, sourceRef: ref('cabecalho', [contactLine], part) };
    else notes.push(`Trecho do cabeçalho não classificado: "${part}".`);
  }
  if (location === undefined) throw new CvParseError('não achei a localização na linha de contato');

  // ---------------------------------------------------------------- seções
  const body = lines.slice(3);
  const sections: { id: SectionId; heading: PdfLine; lines: PdfLine[] }[] = [];
  for (const line of body) {
    const looksLikeHeading =
      line.allBold && line.text === line.text.toUpperCase() && /[A-ZÀ-Ú]{3}/.test(line.text);
    if (looksLikeHeading) {
      const id = HEADINGS[line.text];
      if (id === undefined)
        throw new CvParseError(`título de seção desconhecido na linha ${line.n}: "${line.text}"`);
      sections.push({ id, heading: line, lines: [] });
    } else {
      const current = sections[sections.length - 1];
      if (current === undefined)
        throw new CvParseError(`texto antes da primeira seção (linha ${line.n})`);
      current.lines.push(line);
    }
  }

  let summary: VariantBlock | undefined;
  const experience: Entry[] = [];
  const projects: Entry[] = [];
  const skills: CvMaster['skills'] = [];
  const education: CvMaster['education'] = [];
  const languages: CvMaster['languages'] = [];
  const certifications: CvMaster['certifications'] = [];
  const usedIds = new Set<string>();
  const uniqueId = (base: string): string => {
    let candidate = base;
    for (let n = 2; usedIds.has(candidate); n++) candidate = `${base}-${n}`;
    usedIds.add(candidate);
    return candidate;
  };

  for (const section of sections) {
    const { id: sectionId, lines: sectionLines } = section;
    if (sectionLines.length === 0) {
      notes.push(`A seção "${section.heading.text}" está vazia.`);
      continue;
    }
    if (sectionId === 'resumo') {
      summary = variantBlock('resumo', 'resumo', sectionLines, joinLines(sectionLines), true);
    } else if (sectionId === 'experiencia' || sectionId === 'projetos') {
      const entries = parseEntries(sectionId, sectionLines, takeLink, notes, uniqueId);
      (sectionId === 'experiencia' ? experience : projects).push(...entries);
    } else if (sectionId === 'skills') {
      for (const line of sectionLines) {
        const colon = line.text.indexOf(': ');
        if (colon <= 0)
          throw new CvParseError(`linha de competências sem "Categoria: itens" (linha ${line.n})`);
        const category = line.text.slice(0, colon);
        skills.push({
          id: uniqueId(`skills-${slugify(category)}`),
          category,
          items: splitList(line.text.slice(colon + 2)),
          text: line.text,
          sourceRef: ref('skills', [line], line.text),
        });
      }
    } else if (sectionId === 'educacao') {
      for (const line of sectionLines) {
        const bar = line.text.lastIndexOf(' | ');
        const left = bar > 0 ? line.text.slice(0, bar) : line.text;
        const statusLabel = bar > 0 ? line.text.slice(bar + 3) : '';
        const dash = left.lastIndexOf(' — ');
        if (dash <= 0 || statusLabel === '')
          throw new CvParseError(
            `linha de educação fora do formato "Curso — Instituição | situação" (linha ${line.n})`,
          );
        const course = left.slice(0, dash);
        education.push({
          id: uniqueId(`edu-${slugify(course)}`),
          text: line.text,
          course,
          institution: left.slice(dash + 3),
          statusLabel,
          status: /cursando|em andamento|previs/i.test(statusLabel) ? 'cursando' : 'concluido',
          sourceRef: ref('educacao', [line], line.text),
        });
      }
    } else {
      // idiomas e certificações
      for (const line of sectionLines) {
        const cert = CERTIFICATION.exec(line.text);
        if (LANGUAGE_LINE.test(line.text)) {
          languages.push({
            id: uniqueId(`idiomas-${slugify(line.text.slice(0, 20))}`),
            text: line.text,
            sourceRef: ref('idiomas', [line], line.text),
          });
        } else if (cert) {
          certifications.push({
            id: uniqueId(`cert-${slugify(cert[1] ?? '')}`),
            text: line.text,
            title: cert[1] ?? '',
            issuer: cert[2] ?? '',
            year: Number(cert[3]),
            ...(cert[4] === undefined ? {} : { description: cert[4] }),
            sourceRef: ref('certificacoes', [line], line.text),
          });
        } else
          throw new CvParseError(
            `linha de idiomas/certificações não reconhecida (linha ${line.n}): "${line.text.slice(0, 60)}"`,
          );
      }
    }
  }

  if (summary === undefined) throw new CvParseError('o PDF não tem a seção "Resumo profissional"');
  if (linkQueue.length > 0) {
    throw new CvParseError(
      `${linkQueue.length} link(s) do PDF não foram associados a nenhum texto: ${linkQueue.map((l) => l.label).join(', ')}`,
    );
  }

  const now = options.now ?? new Date();
  const candidate = {
    schemaVersion: 1 as const,
    language: 'pt-BR' as const,
    master: {
      sha256: extraction.sha256,
      label: extraction.label,
      pages: extraction.pages,
      extractedAt: now.toISOString().slice(0, 10),
      extractor: extraction.extractor,
    },
    identity: {
      name: { value: nameLine.text, sourceRef: ref('cabecalho', [nameLine], nameLine.text) },
      headline: variantBlock('headline', 'cabecalho', [headlineLine], headlineLine.text, true),
      location,
      contacts,
      links: identityLinks,
    },
    summary,
    experience,
    projects,
    skills,
    education,
    languages,
    certifications,
    claims: [],
    proposals: { items: [], notProposed: [] },
  };
  const parsed = cvMasterSchema.safeParse(candidate);
  if (!parsed.success) {
    throw new CvParseError(
      `o modelo extraído não passou no esquema: ${parsed.error.issues
        .slice(0, 3)
        .map((i) => `${i.path.join('.')}: ${i.message}`)
        .join('; ')}`,
    );
  }
  return { model: parsed.data, notes };
}

function parseEntries(
  section: 'experiencia' | 'projetos',
  lines: readonly PdfLine[],
  takeLink: (label: string, where: string) => { url: string; page: number },
  notes: string[],
  uniqueId: (base: string) => string,
): Entry[] {
  const entries: Entry[] = [];
  let current:
    | {
        head: PdfLine;
        periodMatch: RegExpExecArray | null;
        blocks: PdfLine[][];
        techLine?: PdfLine;
        last: PdfLine;
      }
    | undefined;

  const flush = (): void => {
    if (current === undefined) return;
    const { head, periodMatch, blocks, techLine } = current;
    const title = normalizeText(periodMatch === null ? head.text : (periodMatch[1] ?? head.text));
    const dash = title.indexOf(' — ');
    const organization = dash > 0 ? title.slice(0, dash) : undefined;
    const role = dash > 0 ? title.slice(dash + 3) : undefined;
    const entryId = uniqueId(
      `${section === 'experiencia' ? 'exp' : 'proj'}-${slugify(organization ?? title)}`,
    );

    let technologies: string[] = [];
    const links: CvLink[] = [];
    if (techLine !== undefined) {
      const match = /^Tecnologias:\s*(.*?)(?:\s*\|\s*Links:\s*(.*))?$/.exec(techLine.text);
      if (!match)
        throw new CvParseError(`linha de tecnologias fora do formato (linha ${techLine.n})`);
      technologies = splitList(match[1] ?? '');
      for (const label of (match[2] ?? '').split(/\s*\|\s*/).filter((l) => l !== '')) {
        const found = takeLink(label, `"${title.slice(0, 40)}"`);
        links.push({
          id: `${entryId}-link-${slugify(label)}`,
          label,
          url: found.url,
          page: found.page,
          confirmedByUser: false,
          status: 'rascunho',
        });
      }
    } else notes.push(`A entrada "${title.slice(0, 50)}" não tem linha de "Tecnologias:".`);

    entries.push({
      id: entryId,
      kind: section === 'experiencia' ? 'experiencia' : 'projeto',
      title,
      ...(organization === undefined || role === undefined ? {} : { organization, role }),
      ...(periodMatch === null
        ? {}
        : {
            period: {
              label: periodMatch[2] ?? '',
              start: periodMatch[3] ?? '',
              ...(periodMatch[4] === undefined ? {} : { end: periodMatch[4] }),
            },
          }),
      bullets: blocks.map((bulletLines, i) => {
        const text = joinLines(bulletLines).replace(/^•\s*/, '');
        return variantBlock(`${entryId}-b${i + 1}`, section, bulletLines, text);
      }),
      technologies,
      links,
      sourceRef: ref(
        section,
        [head, ...(techLine === undefined ? [] : [techLine])].sort((a, b) => a.n - b.n),
        head.text,
      ),
    });
    current = undefined;
  };

  for (const line of lines) {
    if (line.text.startsWith('Tecnologias:')) {
      if (current === undefined)
        throw new CvParseError(`"Tecnologias:" sem entrada (linha ${line.n})`);
      current.techLine = line;
      current.last = line;
    } else if (line.text.startsWith('•')) {
      if (current === undefined) throw new CvParseError(`bullet sem entrada (linha ${line.n})`);
      current.blocks.push([line]);
      current.last = line;
    } else if (line.startsBold) {
      flush();
      current = { head: line, periodMatch: PERIOD.exec(line.text), blocks: [], last: line };
    } else {
      // continuação do bullet anterior
      const lastBlock = current?.blocks[current.blocks.length - 1];
      if (current === undefined || lastBlock === undefined)
        throw new CvParseError(`texto solto na linha ${line.n}: "${line.text.slice(0, 50)}"`);
      lastBlock.push(line);
      current.last = line;
    }
  }
  flush();
  return entries;
}
