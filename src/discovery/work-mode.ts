import { stripAccents } from './text.js';

export type WorkMode = 'remoto' | 'hibrido' | 'presencial';

const PATTERNS: readonly (readonly [WorkMode, RegExp])[] = [
  ['hibrido', /\b(?:hibrid[oa]s?|hybrid)\b/g],
  ['remoto', /\b(?:remot[oa]s?|remote|home ?office|work from home|teletrabalho)\b/g],
  ['presencial', /\b(?:presenciais|presencial|on-?site|in-?office)\b/g],
];

/** Negação até poucas palavras antes ('não é um modelo presencial'). */
const NEGATION_NEAR = /\b(?:nao|sem|nem|not)\b[^.;]{0,22}$/;

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
 * Frases declarativas e específicas na descrição ("modelo 100% presencial", "estagiar presencialmente",
 * "disponibilidade para trabalhar em regime híbrido"). Menções soltas ("vagas presenciais ou híbridas",
 * "pode ser remoto") não bastam: precisam ser a regra da própria vaga.
 */
const DECLARATIVE = [
  /\b(?:modelo|regime|formato|jornada|modalidade)(?:\s+de\s+(?:trabalho|estagio))?\s+(?:sera\s+|e\s+|:\s*)?(?:100%\s*)?(hibrid[oa]s?|remot[oa]s?|presencial)\b/g,
  /\b(?:estagiar|trabalhar|atuar)\s+(?:de\s+forma\s+|em\s+modelo\s+|em\s+regime\s+)?(presencialmente|remotamente|hibrid[oa]|presencial|remoto)\b/g,
  /\b(?:vaga|estagio|posicao)\s+(?:100%\s*)?(presencial|hibrid[oa]|remot[oa])\b/g,
];

function declarativeIn(description: string): WorkMode | null {
  const found = new Set<WorkMode>();
  const normalized = stripAccents(description).toLowerCase();
  for (const pattern of DECLARATIVE) {
    for (const match of normalized.matchAll(pattern)) {
      const word = match[1] ?? '';
      const before = normalized.slice(Math.max(0, match.index - 30), match.index);
      if (NEGATION_BEFORE.test(before) || NEGATION_NEAR.test(before)) continue;
      if (word.startsWith('hibrid')) found.add('hibrido');
      else if (word.startsWith('remot')) found.add('remoto');
      else if (word.startsWith('presencial')) found.add('presencial');
    }
  }
  return resolve(found);
}

/**
 * Detecta a modalidade sem presumir nada. Usa título e localização; a descrição só vale
 * quando traz o campo rotulado ("Modalidade: híbrido") ou uma frase declarativa da própria vaga.
 * Desconhecida ou ambígua → `null`.
 */
export function detectWorkMode(parts: {
  title: string;
  location: string | null;
  description: string | null;
}): WorkMode | null {
  const strong = modesIn(`${parts.title}\n${parts.location ?? ''}`);
  if (strong.size > 0) return resolve(strong);

  const labeled = LABELED.exec(stripAccents(parts.description ?? ''))?.[1];
  const fromLabel = labeled === undefined ? null : resolve(modesIn(labeled));
  if (fromLabel !== null) return fromLabel;
  return parts.description === null ? null : declarativeIn(parts.description);
}
