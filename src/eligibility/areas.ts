import { stripAccents } from '../discovery/text.js';

export const AREAS = [
  'desenvolvimento',
  'qa',
  'suporte',
  'infraestrutura',
  'dados',
  'banco-de-dados',
] as const;
export type Area = (typeof AREAS)[number];

export const AREA_LABELS: Record<Area, string> = {
  desenvolvimento: 'Desenvolvimento',
  qa: 'QA/Testes',
  suporte: 'Suporte',
  infraestrutura: 'Infraestrutura',
  dados: 'Dados',
  'banco-de-dados': 'Banco de Dados',
};

export function norm(value: string): string {
  return stripAccents(value).toLowerCase();
}

/** Nomes de área do perfil (texto livre) → áreas canônicas. Nomes desconhecidos são ignorados. */
const PROFILE_ALIASES: readonly (readonly [RegExp, Area])[] = [
  [
    /full.?stack|front.?end|back.?end|desenvolv|software|programa|mobile|web|dev\b/,
    'desenvolvimento',
  ],
  [/^qa$|qualidade|teste|quality/, 'qa'],
  [/suporte|support|help.?desk|service.?desk/, 'suporte'],
  [/infra|devops|sre|cloud|redes|network|sysadmin/, 'infraestrutura'],
  [/banco.?de.?dados|database|dba/, 'banco-de-dados'],
  [/^dados$|^data|analytics|business intelligence|^bi$|machine learning/, 'dados'],
];

export function canonicalProfileAreas(areas: readonly string[]): Set<Area> {
  const result = new Set<Area>();
  for (const raw of areas) {
    const key = norm(raw).trim();
    for (const [pattern, area] of PROFILE_ALIASES) {
      if (pattern.test(key)) result.add(area);
    }
  }
  return result;
}

/** Palavras do título (mais confiáveis). */
const TITLE_PATTERNS: Record<Area, RegExp> = {
  desenvolvimento:
    /\b(desenvolv\w*|developer|dev|software|programa(?:dor|cao)\w*|back ?end|front ?end|full ?stack|mobile|web|sistemas)\b/,
  qa: /\b(qa|quality assurance|qualidade de software|testes? de software|testador\w*|tester|sdet|test automation|automacao de testes)\b/,
  suporte:
    /\b(suporte (?:tecnico|ti|de ti|a ti|n[123]|de sistemas)|technical support|it support|help ?desk|service ?desk|support engineer)\b/,
  infraestrutura:
    /\b(infra\w*|devops|sre|cloud|redes(?! sociais)|network\w*|sysadmin|administrador\w* de sistemas)\b/,
  dados:
    /\b(dados|data|analytics|business intelligence|bi|etl|machine learning|ciencia de dados)\b/,
  'banco-de-dados': /\b(dba|banco de dados|bancos de dados|database|sql|nosql)\b/,
};

/** Na descrição, termos genéricos como "data" (a data) geram ruído; só termos específicos. */
const DESCRIPTION_PATTERNS: Record<Area, RegExp> = {
  ...TITLE_PATTERNS,
  dados:
    /\b(ciencia de dados|data science|data scientist|data engineer\w*|engenharia de dados|analise de dados|analista de dados|data analyst|business intelligence|machine learning|analytics)\b/,
};

const NON_IT =
  /\b(marketing|redes sociais|comercial|vendas?|sales|financ\w*|contab\w*|juridic\w*|rh|recursos humanos|people|atendimento|logistic\w*|administrativ\w*|customer (?:success|service|experience|support)|social media|conteudo|content|jornalis\w*|direito|ugc|creative|criativ\w*|audio|design|payroll|corporate desk|wealth|onboarding|workplace|compliance|operac\w*|operations|growth|brand|comunicacao)\b/;

const GENERIC_IT = /\b(ti|t\.i|tecnologia|technology|tech|engineering|engenharia|engineer|it)\b/;

export interface AreaClassification {
  fromTitle: Area[];
  fromDescription: Area[];
  /** O título parece ser de área fora de TI e não cita nenhuma área de TI. */
  nonIt: boolean;
  genericIt: boolean;
}

function matching(patterns: Record<Area, RegExp>, text: string): Area[] {
  // "banco de dados" não deve contar também como "dados".
  const cleaned = text.replace(/bancos? de dados/g, 'bancodedados');
  const found = AREAS.filter((area) =>
    patterns[area].test(area === 'banco-de-dados' ? text : cleaned),
  );
  return found;
}

export function classifyJobAreas(
  title: string,
  description: string | null | undefined,
): AreaClassification {
  const t = norm(title);
  const fromTitle = matching(TITLE_PATTERNS, t);
  const fromDescription =
    fromTitle.length === 0 && description ? matching(DESCRIPTION_PATTERNS, norm(description)) : [];
  return {
    fromTitle,
    fromDescription,
    nonIt: fromTitle.length === 0 && NON_IT.test(t),
    genericIt: GENERIC_IT.test(t),
  };
}
