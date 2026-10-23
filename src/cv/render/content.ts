import type { ResolvedEntry, ResolvedLink, ResolvedResume, ResolvedSkill } from '../resolve.js';
import type { LayoutConfig } from './layout.js';

/**
 * Descrição do conteúdo do currículo: a ÚNICA fonte da composição textual (rótulos, títulos em maiúsculas,
 * "Rótulo: url", linha de tecnologias…). O renderizador desenha com estas funções e o validador pós-render
 * monta o texto esperado com `describeContent`: assim os dois não podem divergir em silêncio.
 *
 * Só depende de tipos do currículo resolvido e do layout: nada de modelo mestre, PDF ou arquivo.
 */
export type Labels = LayoutConfig['labels'];

/**
 * Espaços em branco normalizados: toda sequência vira UM espaço e as pontas são cortadas. O PDFKit cola as
 * palavras quando recebe 3 ou mais espaços seguidos ("A   B" sai como "AB"), o que estragaria a leitura e a
 * extração. Texto bem formado não muda; só espaços sobrando.
 */
export const tidyText = (text: string): string => text.replace(/\s+/gu, ' ').trim();

const TIDY_SKIP = new Set(['manifest', 'url', 'id', 'kind', 'language', 'area']);

function tidyValue<T>(value: T, key?: string): T {
  if (typeof value === 'string')
    return (key !== undefined && TIDY_SKIP.has(key) ? value : tidyText(value)) as T;
  if (Array.isArray(value)) return value.map((item: unknown) => tidyValue(item, key)) as T;
  if (typeof value === 'object' && value !== null)
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, k === 'manifest' ? v : tidyValue(v, k)]),
    ) as T;
  return value;
}

/** Cópia do currículo resolvido com os espaços normalizados (a entrada original não é alterada). */
export const tidyResume = (resume: ResolvedResume): ResolvedResume => tidyValue(resume);

/** Título de seção como aparece no PDF. */
export const headingText = (label: string): string => label.toLocaleUpperCase('pt-BR');

/** "Rótulo: endereço", exatamente como o link é impresso (e coberto pela anotação clicável). */
export const linkText = (link: ResolvedLink): string => `${link.label}: ${link.url}`;

export const technologiesLabel = (labels: Labels): string => `${labels.technologies}:`;
export const technologiesText = (entry: ResolvedEntry): string => entry.technologies.join(', ');
export const linksLabel = (labels: Labels): string => `${labels.links}:`;

/** Linha de skill: o rótulo ("Categoria:") sai em negrito e o resto em texto normal; juntos formam `skill.text`. */
export function skillParts(skill: ResolvedSkill): { label?: string; body: string } {
  const prefix = `${skill.category}:`;
  return skill.text.startsWith(prefix)
    ? { label: prefix, body: skill.text.slice(prefix.length).trim() }
    : { body: skill.text };
}

export type BlockKind =
  | 'name'
  | 'headline'
  | 'contact'
  | 'link'
  | 'heading'
  | 'paragraph'
  | 'entry-title'
  | 'period'
  | 'bullet'
  | 'technologies-label'
  | 'technologies'
  | 'links-label'
  | 'skill'
  | 'line';

export interface ContentBlock {
  /** Identificador estável, para mensagens de erro. */
  id: string;
  kind: BlockKind;
  /** Texto exato impresso no PDF (sem separadores `|` nem o glifo `•`, que são estrutura). */
  text: string;
  /** Só nos links: o endereço (visível e clicável). */
  url?: string;
}

/**
 * Blocos de texto do currículo, na ORDEM de leitura em que o renderizador os desenha. Cada bloco é o texto
 * de uma unidade de leitura (pode quebrar em várias linhas no PDF).
 */
export function describeContent(resume: ResolvedResume, labels: Labels): ContentBlock[] {
  const blocks: ContentBlock[] = [];
  const push = (id: string, kind: BlockKind, text: string, url?: string): void => {
    blocks.push({ id, kind, text, ...(url === undefined ? {} : { url }) });
  };
  const header = resume.header;
  push('header.name', 'name', header.name);
  push('header.headline', 'headline', header.headline);
  push('header.location', 'contact', header.location);
  header.contacts.forEach((c, i) => {
    push(`header.contact.${i}`, 'contact', c.value);
  });
  header.links.forEach((l) => {
    push(`link.${l.id}`, 'link', linkText(l), l.url);
  });

  push('summary.heading', 'heading', headingText(labels.summary));
  push('summary', 'paragraph', resume.summary);

  const section = (key: 'experience' | 'projects'): void => {
    const data = resume[key];
    if (data.entries.length === 0) return;
    push(`${key}.heading`, 'heading', headingText(data.title));
    for (const entry of data.entries) {
      push(`${entry.id}.title`, 'entry-title', entry.title);
      if (entry.period !== undefined) push(`${entry.id}.period`, 'period', entry.period);
      entry.bullets.forEach((b, i) => {
        push(`${entry.id}.bullet.${i}`, 'bullet', b);
      });
      if (entry.technologies.length > 0) {
        push(`${entry.id}.technologies-label`, 'technologies-label', technologiesLabel(labels));
        push(`${entry.id}.technologies`, 'technologies', technologiesText(entry));
      }
      if (entry.links.length > 0) {
        push(`${entry.id}.links-label`, 'links-label', linksLabel(labels));
        entry.links.forEach((l) => {
          push(`link.${entry.id}.${l.id}`, 'link', linkText(l), l.url);
        });
      }
    }
  };
  section('experience');
  section('projects');

  if (resume.skills.length > 0) {
    push('skills.heading', 'heading', headingText(labels.skills));
    resume.skills.forEach((s, i) => {
      push(`skills.${i}`, 'skill', s.text);
    });
  }
  const lines = (key: string, label: string, texts: string[]): void => {
    if (texts.length === 0) return;
    push(`${key}.heading`, 'heading', headingText(label));
    texts.forEach((t, i) => {
      push(`${key}.${i}`, 'line', t);
    });
  };
  lines('education', labels.education, resume.education);
  lines('languages', labels.languages, resume.languages);
  lines('certifications', labels.certifications, resume.certifications);
  return blocks;
}

/** Quantos bullets (`•`) o PDF deve conter. */
export const bulletCount = (resume: ResolvedResume): number =>
  [...resume.experience.entries, ...resume.projects.entries].reduce(
    (n, e) => n + e.bullets.length,
    0,
  );
