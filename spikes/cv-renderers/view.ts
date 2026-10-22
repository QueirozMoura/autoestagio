/**
 * Árvore de renderização comum aos três renderizadores. Entra o modelo (já aprovado) e uma área;
 * sai um documento só com texto EXATO de blocos/variantes aprovados, na ordem em que deve ser lido.
 * (Protótipo do futuro "motor de seleção" da Etapa 4.2: aqui só escolhe a variante padrão.)
 */
import type { CvModel } from './model.schema.ts';

export interface TextBlock {
  id: string;
  text: string;
}
export interface Link {
  label: string;
  url: string;
}
export type Item =
  | { type: 'paragraph'; id: string; text: string }
  | { type: 'entry'; id: string; title: string; period: string; techs: string; links: Link[]; bullets: TextBlock[] }
  | { type: 'kv'; id: string; label: string; text: string }
  | { type: 'edu'; id: string; title: string; status: string };
export interface Section {
  id: string;
  heading: string;
  items: Item[];
}
export interface Doc {
  lang: 'pt-BR';
  title: string;
  name: string;
  headline: TextBlock;
  /** Linha de contato: local | e-mail | telefone. */
  contact: TextBlock[];
  links: Link[];
  sections: Section[];
}

type VariantBlock = { variants: { id: string; text: Record<string, string | undefined>; areas: string[] }[] };

function pick(block: VariantBlock, area: string | undefined): { id: string; text: string } {
  const chosen = block.variants.find((v) => area !== undefined && v.areas.includes(area)) ?? block.variants[0];
  if (chosen === undefined) throw new Error('bloco sem variantes');
  return { id: chosen.id, text: chosen.text['pt-BR'] ?? '' };
}

const period = (p: { start: string; end?: string | undefined }): string => (p.end === undefined ? p.start : `${p.start} – ${p.end}`);

export function buildDoc(model: CvModel, options: { area?: string } = {}): Doc {
  const area = options.area;
  const entries = (list: CvModel['experience']): Item[] =>
    [...list]
      .sort((a, b) => b.priority - a.priority)
      .map((entry) => ({
        type: 'entry' as const,
        id: entry.id,
        title: entry.title['pt-BR'],
        period: period(entry.period),
        techs: entry.technologies.length === 0 ? '' : `Tecnologias: ${entry.technologies.join(', ')}`,
        links: entry.links.map((l) => ({ label: l.label, url: l.url })),
        bullets: entry.bullets.map((b) => pick(b, area)),
      }));

  const sections: Section[] = [
    { id: 'resumo', heading: 'RESUMO PROFISSIONAL', items: [{ type: 'paragraph', id: pick(model.summary, area).id, text: pick(model.summary, area).text }] },
    { id: 'experiencia', heading: 'EXPERIÊNCIA PROFISSIONAL', items: entries(model.experience) },
    { id: 'projetos', heading: 'PROJETOS DE DESTAQUE', items: entries(model.projects) },
    {
      id: 'skills',
      heading: 'COMPETÊNCIAS TÉCNICAS (SKILLS)',
      items: [...model.skills]
        .sort((a, b) => Number(b.areas.includes(area ?? '')) - Number(a.areas.includes(area ?? '')) || b.priority - a.priority)
        .map((s) => ({ type: 'kv' as const, id: s.id, label: s.category['pt-BR'], text: s.items.join(', ') })),
    },
    {
      id: 'educacao',
      heading: 'EDUCAÇÃO',
      items: model.education.map((e) => ({
        type: 'edu' as const,
        id: e.id,
        title: `${e.course['pt-BR']} — ${e.institution}`,
        status: e.statusLabel['pt-BR'],
      })),
    },
    {
      id: 'idiomas',
      heading: 'IDIOMAS E CERTIFICAÇÕES',
      items: [
        ...model.languages.map((l) => ({ type: 'paragraph' as const, id: l.id, text: l.label['pt-BR'] })),
        ...model.certifications.map((c) => ({
          type: 'paragraph' as const,
          id: c.id,
          text: `${c.title['pt-BR']} — ${c.issuer} (${c.year})`,
        })),
      ],
    },
  ];

  return {
    lang: 'pt-BR',
    title: `Currículo — ${model.identity.name}`,
    name: model.identity.name,
    headline: { id: 'headline', ...pick(model.identity.headline, area) },
    contact: [
      { id: 'local', text: model.identity.location },
      ...model.identity.contacts.map((c) => ({ id: c.id, text: c.value })),
    ],
    links: model.identity.links.map((l) => ({ label: l.label, url: l.url })),
    sections,
  };
}

/** Texto esperado, na ordem de leitura, com o id do bloco. Base das métricas de fidelidade e de ordem. */
export function expectedText(doc: Doc): TextBlock[] {
  const out: TextBlock[] = [{ id: 'name', text: doc.name }, doc.headline, ...doc.contact];
  for (const l of doc.links) out.push({ id: `link:${l.label}`, text: l.label });
  for (const s of doc.sections) {
    out.push({ id: `h:${s.id}`, text: s.heading });
    for (const item of s.items) {
      if (item.type === 'paragraph') out.push({ id: item.id, text: item.text });
      else if (item.type === 'kv') out.push({ id: item.id, text: `${item.label}: ${item.text}` });
      else if (item.type === 'edu') out.push({ id: item.id, text: `${item.title}` }, { id: `${item.id}:status`, text: item.status });
      else {
        out.push({ id: item.id, text: item.title }, { id: `${item.id}:period`, text: item.period });
        for (const b of item.bullets) out.push(b);
        if (item.techs !== '') out.push({ id: `${item.id}:techs`, text: item.techs });
        for (const l of item.links) out.push({ id: `${item.id}:link:${l.label}`, text: l.label });
      }
    }
  }
  return out;
}

/** Design único (A4): usado igualmente pelos três renderizadores. Unidades em pontos. */
export const DESIGN = {
  page: { width: 595.28, height: 841.89 },
  margin: { top: 40, bottom: 38, left: 46, right: 46 },
  font: { regular: 'Lato-Regular', bold: 'Lato-Bold', italic: 'Lato-Italic' },
  size: { name: 20, headline: 10.5, contact: 9, heading: 10, body: 9.2, small: 8.6 },
  color: { text: '#1a1a1a', muted: '#444444', accent: '#1f3a5f' },
  fontFiles: {
    regular: '/usr/share/fonts/truetype/lato/Lato-Regular.ttf',
    bold: '/usr/share/fonts/truetype/lato/Lato-Bold.ttf',
    italic: '/usr/share/fonts/truetype/lato/Lato-Italic.ttf',
  },
} as const;
