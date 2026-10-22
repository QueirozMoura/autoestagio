import { bulletCount, describeContent, type ContentBlock } from '../render/content.js';
import { mergeLayout, type LayoutOverrides } from '../render/layout.js';
import type { ResolvedResume } from '../resolve.js';

/**
 * O que o PDF renderizado DEVE conter, derivado só do `ResolvedResume` e do layout, com a MESMA composição
 * textual do renderizador (módulo compartilhado `render/content.ts`).
 */
export interface Expected {
  /** Blocos de texto na ordem de leitura. */
  blocks: ContentBlock[];
  /** Links que devem estar visíveis e clicáveis (subconjunto de `blocks`). */
  links: { text: string; url: string }[];
  /** Quantidade de bullets (`•`). */
  bullets: number;
  /** Limite de páginas do layout. */
  maxPages: number;
}

export function expectedContent(resume: ResolvedResume, layout?: LayoutOverrides): Expected {
  const merged = mergeLayout(layout);
  const blocks = describeContent(resume, merged.labels);
  return {
    blocks,
    links: blocks.filter((b) => b.kind === 'link').map((b) => ({ text: b.text, url: b.url ?? '' })),
    bullets: bulletCount(resume),
    maxPages: merged.pages.max,
  };
}
