/**
 * Layout declarativo do currículo (A4, uma coluna). Unidades em pontos (pt). Nada aqui conhece o modelo
 * mestre: o renderizador só recebe um `ResolvedResume`.
 *
 * As regras de leitura por ATS vêm do spike 4.0 (docs/CV_RENDERER_SPIKE.md §4): uma coluna, sem tabelas nem
 * imagens, texto real com fonte embutida, sem ligaduras, data na linha do título, mesmo tamanho de fonte na
 * mesma linha, `•` real, URLs visíveis e clicáveis, metadados fixos.
 */
export interface TypeScale {
  name: number;
  headline: number;
  contact: number;
  heading: number;
  body: number;
  small: number;
}

export interface Spacing {
  /** Espaço antes de cada seção. */
  section: number;
  /** Espaço entre o título da seção (com filete) e o conteúdo. */
  afterHeading: number;
  /** Entre linhas de um mesmo parágrafo (lineGap do PDFKit). */
  line: number;
  /** Entre bullets. */
  bullet: number;
  /** Entre entradas (experiência/projeto). */
  entry: number;
  /** Entre parágrafos e linhas soltas. */
  paragraph: number;
}

/** Um degrau de ajuste: escala da tipografia e do espaçamento (1 = o layout declarado). */
export interface FitStep {
  font: number;
  space: number;
}

export interface LayoutConfig {
  page: { width: number; height: number };
  margin: { top: number; bottom: number; left: number; right: number };
  size: TypeScale;
  spacing: Spacing;
  color: { text: string; muted: string; accent: string };
  /** Recuo do texto do bullet em relação à margem esquerda. */
  bulletIndent: number;
  /** Filete fino sob os títulos de seção (não afeta a extração de texto). */
  headingRule: boolean;
  pages: {
    /** Meta: cabe em tantas páginas, se der. */
    preferred: number;
    /** Limite duro: acima disso é erro controlado (nunca se remove nem resume conteúdo). */
    max: number;
  };
  /**
   * Degraus de ajuste do maior para o menor. O primeiro é o layout declarado. Só tipografia e espaçamento
   * mudam; o texto nunca é alterado nem removido.
   */
  fit: FitStep[];
  /** Rótulos estruturais do renderizador (não vêm do currículo). */
  labels: {
    summary: string;
    skills: string;
    education: string;
    languages: string;
    certifications: string;
    technologies: string;
    links: string;
  };
  metadata: {
    producer: string;
    creator: string;
    subject: string;
    /** Data fixa: o PDF não depende do relógio (determinismo). */
    date: Date;
  };
}

/** Tamanho mínimo absoluto do corpo do texto: abaixo disso o PDF vira ilegível e a resolução falha. */
export const MIN_BODY_PT = 8;

export const DEFAULT_LAYOUT: LayoutConfig = {
  page: { width: 595.28, height: 841.89 }, // A4
  margin: { top: 40, bottom: 38, left: 46, right: 46 },
  size: { name: 20, headline: 10.5, contact: 9, heading: 10, body: 9.2, small: 8.6 },
  spacing: { section: 8, afterHeading: 3, line: 1.2, bullet: 1.5, entry: 4, paragraph: 2.5 },
  color: { text: '#1a1a1a', muted: '#444444', accent: '#1f3a5f' },
  bulletIndent: 14,
  headingRule: true,
  pages: { preferred: 1, max: 2 },
  fit: [
    { font: 1, space: 1 },
    { font: 1, space: 0.85 },
    { font: 1, space: 0.7 },
    { font: 0.97, space: 0.7 },
    { font: 0.94, space: 0.6 },
    { font: 0.92, space: 0.5 },
  ],
  labels: {
    summary: 'Resumo profissional',
    skills: 'Competências técnicas',
    education: 'Formação acadêmica',
    languages: 'Idiomas',
    certifications: 'Certificações',
    technologies: 'Tecnologias',
    links: 'Links',
  },
  metadata: {
    producer: 'AutoEstagio',
    creator: 'AutoEstagio',
    subject: 'Currículo',
    date: new Date('2026-01-01T00:00:00Z'),
  },
};

export type LayoutOverrides = {
  [K in keyof LayoutConfig]?: LayoutConfig[K] extends object
    ? LayoutConfig[K] extends unknown[] | Date
      ? LayoutConfig[K]
      : Partial<LayoutConfig[K]>
    : LayoutConfig[K];
};

export function mergeLayout(overrides: LayoutOverrides = {}): LayoutConfig {
  const base = DEFAULT_LAYOUT;
  return {
    page: { ...base.page, ...overrides.page },
    margin: { ...base.margin, ...overrides.margin },
    size: { ...base.size, ...overrides.size },
    spacing: { ...base.spacing, ...overrides.spacing },
    color: { ...base.color, ...overrides.color },
    bulletIndent: overrides.bulletIndent ?? base.bulletIndent,
    headingRule: overrides.headingRule ?? base.headingRule,
    pages: { ...base.pages, ...overrides.pages },
    fit: overrides.fit ?? base.fit,
    labels: { ...base.labels, ...overrides.labels },
    metadata: { ...base.metadata, ...overrides.metadata },
  };
}

/** Valida o layout; devolve os problemas (lista vazia = válido). */
export function layoutProblems(layout: LayoutConfig): string[] {
  const problems: string[] = [];
  const positive = (value: number, what: string): void => {
    if (!Number.isFinite(value) || value <= 0) problems.push(`${what} deve ser > 0`);
  };
  positive(layout.page.width, 'page.width');
  positive(layout.page.height, 'page.height');
  for (const [key, value] of Object.entries(layout.size as unknown as Record<string, number>))
    positive(value, `size.${key}`);
  for (const [key, value] of Object.entries(layout.margin as unknown as Record<string, number>))
    if (!Number.isFinite(value) || value < 0) problems.push(`margin.${key} deve ser >= 0`);
  if (layout.margin.left + layout.margin.right >= layout.page.width)
    problems.push('margens horizontais ocupam a página inteira');
  if (layout.margin.top + layout.margin.bottom >= layout.page.height)
    problems.push('margens verticais ocupam a página inteira');
  if (!Number.isInteger(layout.pages.preferred) || layout.pages.preferred < 1)
    problems.push('pages.preferred deve ser inteiro >= 1');
  if (!Number.isInteger(layout.pages.max) || layout.pages.max < layout.pages.preferred)
    problems.push('pages.max deve ser inteiro >= pages.preferred');
  if (layout.fit.length === 0) problems.push('fit precisa de ao menos um degrau');
  layout.fit.forEach((step, i) => {
    if (step.font <= 0 || step.font > 1) problems.push(`fit[${i}].font deve estar em (0, 1]`);
    if (step.space <= 0 || step.space > 1) problems.push(`fit[${i}].space deve estar em (0, 1]`);
    if (layout.size.body * step.font < MIN_BODY_PT)
      problems.push(
        `fit[${i}] reduz o corpo para ${(layout.size.body * step.font).toFixed(2)} pt (mínimo ${MIN_BODY_PT} pt)`,
      );
  });
  return problems;
}
