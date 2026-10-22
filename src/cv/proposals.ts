import { AREAS } from '../eligibility/areas.js';
import type { Proposal, CvMaster } from './schema.js';

/**
 * Variantes de resumo e destaques por área, montados SÓ por seleção e junção de trechos do próprio
 * currículo mestre: cada trecho é cópia exata (a 1ª letra pode virar maiúscula) e vem com a origem.
 * Nenhuma palavra nova entra. Tudo nasce `proposta`: só vale depois de você aprovar.
 *
 * Os léxicos abaixo são genéricos (não contêm dados de ninguém): decidem o que "casa" com cada área.
 */
type Area = (typeof AREAS)[number];

interface AreaRule {
  /** Termos que pontuam o trecho. */
  match: RegExp;
  /** Termos que provam evidência real da área; sem pelo menos 2 trechos com eles, não se propõe nada. */
  strong: RegExp;
}

const RULES: Partial<Record<Area, AreaRule>> = {
  qa: {
    match:
      /teste|E2E|Playwright|Vitest|Testing Library|integração|CI\b|GitHub Actions|cobertura|qualidade|concorrência/gi,
    strong: /teste|E2E|Playwright|Vitest|Testing Library/i,
  },
  'banco-de-dados': {
    match:
      /PostgreSQL|SQL|MySQL|SQLite|Prisma|transaç|bloqueio de linha|constraint|Decimal|idempot|banco|integridade|índice/gi,
    strong: /PostgreSQL|MySQL|SQLite|transaç|constraint|bloqueio de linha|Decimal/i,
  },
  infraestrutura: {
    match: /deploy|Vercel|Render|Docker|CI\/CD|GitHub Actions|produção|Supabase|Neon|container/gi,
    strong: /deploy|Vercel|Render|Docker|CI\/CD|GitHub Actions/i,
  },
  suporte: {
    match: /suporte|atendimento|chamado|help ?desk|service ?desk|ticket/gi,
    strong: /suporte técnico|help ?desk|service ?desk|chamados?|n[1-3]\b/i,
  },
  dados: {
    match:
      /analytics|business intelligence|\bBI\b|ETL|ciência de dados|machine learning|pandas|power ?bi|tableau|dashboard/gi,
    strong:
      /analytics|business intelligence|\bBI\b|ETL|ciência de dados|machine learning|pandas|power ?bi|tableau/i,
  },
};

const NEUTRAL =
  /produção|segurança|concorrência|idempot|testes|integridade|autenticação|OAuth|JWT|HMAC|deploy|multi-empresa|isolamento|sincroniza|offline|CRDT|constraint|transaç|e-commerce|pagamentos/gi;
const NUMBER_CLAIM = /\d[\d.]*\s+(?:pessoas|usuários|clientes|testes)|\bmais\s+de\s+\d/i;

const SUMMARY_BUDGET = 480;
const HIGHLIGHT_MAX = 300;

interface Clause {
  blockId: string;
  entryId?: string;
  text: string;
  hasNumberClaim: boolean;
  order: number;
}

const stripEnd = (value: string): string => value.replace(/[\s.;,]+$/g, '').trim();
const capitalize = (value: string): string =>
  value === '' ? value : `${value.charAt(0).toUpperCase()}${value.slice(1)}`;
const compose = (fragments: readonly string[]): string =>
  `${fragments.map((f) => capitalize(stripEnd(f))).join('. ')}.`;

function splitClauses(text: string): string[] {
  return text
    .split(/;\s+|(?<=\.)\s+(?=[A-ZÀ-Ú])/)
    .map(stripEnd)
    .filter((c) => c.length >= 12);
}

function collectClauses(model: CvMaster): {
  summary: Clause[];
  entries: Map<string, Clause[]>;
  closing: Clause | undefined;
} {
  let order = 0;
  const make = (blockId: string, text: string, entryId?: string): Clause[] =>
    splitClauses(text).map((c) => ({
      blockId,
      ...(entryId === undefined ? {} : { entryId }),
      text: c,
      hasNumberClaim: NUMBER_CLAIM.test(c),
      order: order++,
    }));
  const summary = model.summary.variants.flatMap((v) => make(v.id, v.text));
  const closing = summary.find((c) => /^(Estudante|Graduand|Cursando)/i.test(c.text));
  const entries = new Map<string, Clause[]>();
  for (const entry of [...model.experience, ...model.projects]) {
    entries.set(
      entry.id,
      entry.bullets.flatMap((b) => b.variants.flatMap((v) => make(v.id, v.text, entry.id))),
    );
  }
  return { summary, entries, closing };
}

const scoreWith = (rule: RegExp, text: string): number =>
  (
    text.match(new RegExp(rule.source, rule.flags.includes('g') ? rule.flags : `${rule.flags}g`)) ??
    []
  ).length;

/** Escolhe trechos de maior pontuação, de blocos diferentes, dentro do orçamento de caracteres. */
function pick(
  clauses: readonly Clause[],
  score: (c: Clause) => number,
  options: { max: number; budget: number; allowNumbers: boolean },
): Clause[] {
  const candidates = clauses
    .filter((c) => score(c) > 0 && (options.allowNumbers || !c.hasNumberClaim))
    .sort((a, b) => score(b) - score(a) || a.order - b.order);
  const chosen: Clause[] = [];
  let used = 0;
  for (const prefer of [true, false]) {
    for (const clause of candidates) {
      if (chosen.length >= options.max || chosen.includes(clause)) continue;
      if (prefer && chosen.some((c) => c.blockId === clause.blockId)) continue;
      const cost = clause.text.length + 2;
      if (used + cost > options.budget) continue;
      chosen.push(clause);
      used += cost;
    }
  }
  return chosen.sort((a, b) => a.order - b.order);
}

const fromClauses = (clauses: readonly Clause[]): Proposal['composedFrom'] =>
  clauses.map((c) => ({ blockId: c.blockId, fragment: c.text }));

export interface ProposalSet {
  items: Proposal[];
  notProposed: { area: Area; reason: string }[];
}

export function buildProposals(model: CvMaster): ProposalSet {
  const { summary, entries, closing } = collectClauses(model);
  const all = [...summary, ...[...entries.values()].flat()];
  const items: Proposal[] = [];
  const notProposed: ProposalSet['notProposed'] = [];

  // ---- Resumo por área.
  const masterSummary = model.summary.variants[0];
  if (masterSummary !== undefined) {
    items.push({
      id: 'prop-resumo-desenvolvimento-verbatim',
      kind: 'resumo',
      area: 'desenvolvimento',
      variant: 'verbatim',
      text: masterSummary.text,
      composedFrom: [{ blockId: masterSummary.id, fragment: masterSummary.text }],
      flags: ['texto original do currículo, sem alterações'],
      status: 'proposta',
    });
  }
  for (const area of AREAS) {
    const rule = RULES[area];
    if (rule === undefined) continue;
    const evidence = all.filter((c) => rule.strong.test(c.text));
    const distinctBlocks = new Set(evidence.map((c) => c.blockId)).size;
    if (distinctBlocks < 2) {
      notProposed.push({
        area,
        reason: `Sem evidência suficiente no currículo: ${evidence.length === 0 ? 'nenhum trecho cita' : `só ${distinctBlocks} bloco cita`} termos próprios da área (${rule.strong.source.slice(0, 70)}). Nada foi inventado.`,
      });
      continue;
    }
    const score = (c: Clause): number => scoreWith(rule.match, c.text);
    const budget = SUMMARY_BUDGET - (closing === undefined ? 0 : closing.text.length + 2);
    const without = pick(
      all.filter((c) => c !== closing),
      score,
      { max: 3, budget, allowNumbers: false },
    );
    const withNumbers = pick(
      all.filter((c) => c !== closing),
      score,
      { max: 3, budget, allowNumbers: true },
    );
    const variants: { variant: 'sem-numeros' | 'com-numeros'; clauses: Clause[] }[] = [
      { variant: 'sem-numeros', clauses: without },
    ];
    if (withNumbers.some((c) => c.hasNumberClaim))
      variants.push({ variant: 'com-numeros', clauses: withNumbers });
    for (const { variant, clauses } of variants) {
      if (clauses.length === 0) continue;
      const parts = [...clauses, ...(closing === undefined ? [] : [closing])];
      items.push({
        id: `prop-resumo-${area}-${variant}`,
        kind: 'resumo',
        area,
        variant,
        text: compose(parts.map((c) => c.text)),
        composedFrom: fromClauses(parts),
        flags: [
          'montado só com trechos do currículo; o encadeamento pode exigir ajuste de estilo (qualquer edição manual vira nova variante a aprovar)',
          ...(variant === 'com-numeros' ? ['contém números que dependem da sua confirmação'] : []),
          ...(distinctBlocks < 3 ? ['evidência parcial para esta área'] : []),
        ],
        status: 'proposta',
      });
    }
  }
  for (const area of AREAS) {
    if (!RULES[area] && area !== 'desenvolvimento')
      notProposed.push({ area, reason: 'Sem regra de seleção para esta área.' });
  }

  // ---- Destaques por projeto/experiência.
  for (const entry of [...model.experience, ...model.projects]) {
    const clauses = entries.get(entry.id) ?? [];
    const score = (c: Clause): number => scoreWith(NEUTRAL, c.text);
    const build = (allowNumbers: boolean): Clause[] => {
      let chosen = pick(clauses, score, { max: 2, budget: HIGHLIGHT_MAX, allowNumbers });
      while (chosen.length > 1 && compose(chosen.map((c) => c.text)).length > HIGHLIGHT_MAX)
        chosen = chosen.slice(0, -1);
      return chosen;
    };
    const without = build(false);
    const withNumbers = build(true);
    const make = (
      variant: 'sem-numeros' | 'com-numeros',
      chosen: Clause[],
    ): Proposal | undefined => {
      if (chosen.length === 0) return undefined;
      let text = compose(chosen.map((c) => c.text));
      const flags = ['trechos do próprio currículo'];
      const fragments = fromClauses(chosen);
      if (text.length > HIGHLIGHT_MAX && fragments.length === 1 && fragments[0] !== undefined) {
        // Um trecho só e longo demais: corta na última vírgula que cabe (continua sendo subtrecho exato).
        const cut = fragments[0].fragment.slice(0, HIGHLIGHT_MAX - 1);
        const comma = cut.lastIndexOf(', ');
        if (comma > 40) {
          fragments[0] = { blockId: fragments[0].blockId, fragment: cut.slice(0, comma) };
          text = compose([fragments[0].fragment]);
          flags.push('trecho cortado numa vírgula para caber em 300 caracteres');
        }
      }
      if (text.length > HIGHLIGHT_MAX) return undefined;
      if (variant === 'com-numeros') flags.push('contém números que dependem da sua confirmação');
      return {
        id: `prop-destaque-${entry.id}-${variant}`.slice(0, 90),
        kind: 'destaque',
        projectId: entry.id,
        variant,
        text,
        composedFrom: fragments,
        flags,
        status: 'proposta',
      };
    };
    const a = make('sem-numeros', without);
    if (a !== undefined) items.push(a);
    if (withNumbers.some((c) => c.hasNumberClaim)) {
      const b = make('com-numeros', withNumbers);
      if (b !== undefined && b.text !== a?.text) items.push(b);
    }
  }
  return { items, notProposed };
}

// ------------------------------------------------------------------ verificação

const wordsOf = (value: string): string[] =>
  value
    .normalize('NFC')
    .toLowerCase()
    .match(/[\p{L}\p{N}][\p{L}\p{N}.+#/_-]*/gu) ?? [];

/** Confere a procedência de cada proposta: trechos exatos do mestre, nenhuma palavra nova, limites. */
export function verifyProposals(model: CvMaster, proposals: readonly Proposal[]): string[] {
  const problems: string[] = [];
  const blockTexts = new Map<string, string>();
  for (const v of [...model.identity.headline.variants, ...model.summary.variants])
    blockTexts.set(v.id, v.text);
  for (const entry of [...model.experience, ...model.projects])
    for (const b of entry.bullets) for (const v of b.variants) blockTexts.set(v.id, v.text);
  const masterWords = new Set(wordsOf([...blockTexts.values()].join(' ')));

  for (const p of proposals) {
    for (const part of p.composedFrom) {
      const source = blockTexts.get(part.blockId);
      if (source === undefined)
        problems.push(`${p.id}: bloco "${part.blockId}" não existe no modelo`);
      else if (!source.includes(part.fragment))
        problems.push(`${p.id}: o trecho não é cópia exata do bloco "${part.blockId}"`);
    }
    const expected =
      p.variant === 'verbatim' ? p.text : compose(p.composedFrom.map((c) => c.fragment));
    if (expected !== p.text) problems.push(`${p.id}: o texto não é a junção dos trechos`);
    const fresh = wordsOf(p.text).filter((w) => !masterWords.has(w));
    if (fresh.length > 0)
      problems.push(
        `${p.id}: palavras que não estão no currículo: ${fresh.slice(0, 5).join(', ')}`,
      );
    if (p.kind === 'destaque' && p.text.length > HIGHLIGHT_MAX)
      problems.push(`${p.id}: passa de ${HIGHLIGHT_MAX} caracteres`);
  }
  return problems;
}
