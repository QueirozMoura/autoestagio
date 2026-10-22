import { stripAccents } from './text.js';

export type WorkMode = 'remoto' | 'hibrido' | 'presencial';

const PATTERNS: readonly (readonly [WorkMode, RegExp])[] = [
  ['hibrido', /\b(?:hibrid[oa]s?|hybrid)\b/g],
  ['remoto', /\b(?:remot[oa]s?|remote|home ?office|work from home|teletrabalho)\b/g],
  ['presencial', /\b(?:presenciais|presencial|on-?site|in-?office)\b/g],
];

const NEGATION_BEFORE = /\b(?:nao|sem|nem|not|no)\s+(?:e\s+|eh\s+|ha\s+|ser\s+|is\s+)?$/;

function modesIn(text: string): Set<WorkMode> {
  const normalized = stripAccents(text).toLowerCase();
  const found = new Set<WorkMode>();
  for (const [mode, pattern] of PATTERNS) {
    for (const match of normalized.matchAll(pattern)) {
      const before = normalized.slice(Math.max(0, match.index - 14), match.index);
      if (!NEGATION_BEFORE.test(before)) found.add(mode);
    }
  }
  return found;
}

/** Híbrido vence quando citado junto de outro ("Híbrido, 2x remoto"); conflitos viram `null`. */
function resolve(modes: ReadonlySet<WorkMode>): WorkMode | null {
  if (modes.has('hibrido')) return 'hibrido';
  if (modes.size === 1) return [...modes][0] ?? null;
  return null;
}

const LABELED =
  /(?:modalidade|modelo de trabalho|regime de trabalho|formato de trabalho|local de trabalho)\s*[:\-–]?\s*([^\n.;]{0,40})/i;

/**
 * Detecta a modalidade sem presumir nada. Usa título e localização; a descrição só vale
 * quando traz o campo rotulado ("Modalidade: híbrido"). Desconhecida ou ambígua → `null`.
 */
export function detectWorkMode(parts: {
  title: string;
  location: string | null;
  description: string | null;
}): WorkMode | null {
  const strong = modesIn(`${parts.title}\n${parts.location ?? ''}`);
  if (strong.size > 0) return resolve(strong);

  const labeled = LABELED.exec(stripAccents(parts.description ?? ''))?.[1];
  return labeled === undefined ? null : resolve(modesIn(labeled));
}
