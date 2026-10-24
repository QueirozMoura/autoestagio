import { stripAccents } from '../discovery/text.js';

/**
 * Áreas dos CURRÍCULOS (variantes aprovadas). Usadas pelo módulo de currículos (esquema do modelo, fluxo
 * estrito, decisões): NÃO são o conjunto de áreas de vagas e não mudam com a ampliação da busca.
 */
export const AREAS = [
  'desenvolvimento',
  'qa',
  'suporte',
  'infraestrutura',
  'dados',
  'banco-de-dados',
] as const;
export type Area = (typeof AREAS)[number];

/**
 * Áreas de VAGAS (elegibilidade e busca): todas as áreas de tecnologia, com a mesma prioridade. As seis
 * primeiras coincidem com as áreas de currículo; as demais usam o currículo genérico como sugestão.
 */
export const JOB_AREAS = [
  ...AREAS,
  'seguranca',
  'governanca',
  'sistemas-corporativos',
  'automacao',
  'ti-geral',
] as const;
export type JobArea = (typeof JOB_AREAS)[number];

export const AREA_LABELS: Record<JobArea, string> = {
  desenvolvimento: 'Desenvolvimento',
  qa: 'QA/Testes',
  suporte: 'Suporte',
  infraestrutura: 'Infraestrutura',
  dados: 'Dados',
  'banco-de-dados': 'Banco de Dados',
  seguranca: 'Segurança da Informação',
  governanca: 'Governança de TI',
  'sistemas-corporativos': 'Sistemas Corporativos/ERP',
  automacao: 'Automação/Transformação Digital',
  'ti-geral': 'TI (geral)',
};

export function norm(value: string): string {
  return stripAccents(value).toLowerCase();
}

/** Valores do perfil que significam "qualquer área de tecnologia". */
const WILDCARD = /^(?:todas?|qualquer|todas as areas( de ti| de tecnologia)?|todas-ti)$/;

/** Nomes de área do perfil (texto livre) → áreas canônicas. Nomes desconhecidos NÃO são aceitos em silêncio. */
const PROFILE_ALIASES: readonly (readonly [RegExp, JobArea])[] = [
  [
    /full.?stack|front.?end|back.?end|desenvolv|software|programa|mobile|web|dev\b/,
    'desenvolvimento',
  ],
  [/^qa$|qualidade|teste|quality/, 'qa'],
  [/suporte|support|help.?desk|service.?desk/, 'suporte'],
  [/infra|devops|sre|cloud|redes|network|sysadmin/, 'infraestrutura'],
  [/banco.?de.?dados|database|dba/, 'banco-de-dados'],
  [/^dados$|^data|analytics|business intelligence|^bi$|machine learning/, 'dados'],
  [/seguranca|security|ciber|cyber|infosec/, 'seguranca'],
  [/governanca|governance|grc|itil|cobit/, 'governanca'],
  [/erp|sistemas.?corporativos|sap\b|protheus|totvs/, 'sistemas-corporativos'],
  [/automacao|automation|rpa|transformacao.?digital/, 'automacao'],
  [/^ti(?:.?geral)?$|^tecnologia$|tecnologia.?da.?informacao|informatica/, 'ti-geral'],
];

export function canonicalProfileAreas(areas: readonly string[]): Set<JobArea> {
  const result = new Set<JobArea>();
  for (const raw of areas) {
    const key = norm(raw).trim();
    if (WILDCARD.test(key)) {
      for (const area of JOB_AREAS) result.add(area);
      continue;
    }
    for (const [pattern, area] of PROFILE_ALIASES) {
      if (pattern.test(key)) result.add(area);
    }
  }
  return result;
}

/** Nomes de área do perfil que não correspondem a nenhuma área conhecida (para avisar o usuário). */
export function unknownProfileAreas(areas: readonly string[]): string[] {
  return areas.filter((raw) => {
    const key = norm(raw).trim();
    return !WILDCARD.test(key) && !PROFILE_ALIASES.some(([pattern]) => pattern.test(key));
  });
}

/** Sinais FORTES no título: específicos o bastante para indicar a área sozinhos. */
const TITLE_PATTERNS: Record<JobArea, RegExp> = {
  desenvolvimento:
    /\b(desenvolv\w+ (?:de |em )?(?:software|sistemas?|aplicac\w+|apps?|web|mobile|java\w*|python|react|node\w*)|desenvolvedor\w*|developer|devs?|software (?:engineer|developer|development)|engenharia de software|programador\w*|programacao(?! (?:de )?(?:producao|obras?|manutencao|eventos|conteudo|tv|midia|visual))|back ?end|front ?end|full ?stack|mobile (?:developer|dev)|desenvolvimento(?! (?:de |do |da )?(?:negocios?|humano|organizacional|comercial|produtos?|pessoas|mercado|imobiliario|talentos|sustentavel|rural|economico|social|lideranca|carreira|de equipes)))\b/,
  qa: /\b(qa|quality assurance|qualidade de software|testes? (?:de )?software|testes? automatizados?|testador\w*|tester|sdet|test automation|automacao de testes?)\b/,
  suporte:
    /\b(suporte (?:tecnico|ti|de ti|a ti|em ti|n[123]|de sistemas|de informatica|de infraestrutura|de aplicac\w+|a aplicac\w+|a sistemas|ao usuario|a usuarios|de redes|de hardware|de software)|technical support|it support|help ?desk|service ?desk|servicedesk|atendimento (?:de ti|tecnico|ao usuario de ti|n[123])|tecnico\w* (?:de|em) (?:ti|informatica|suporte|redes|manutencao de computadores)|analista de suporte)\b/,
  infraestrutura:
    /\b(infra(?:estrutura)?(?! (?:civil|predial|viaria|urbana|de obras|eletrica|de saneamento|ferroviaria))|devops|sre|cloud|redes(?! sociais)|network\w*|sysadmin|administra\w+ de (?:sistemas|servidores|redes)|servidores(?! (?:publicos?|municipais|estaduais|federais))|virtualizacao|data ?center|telecom\w*)\b/,
  dados:
    /\b((?<!protecao de )dados(?! pessoais)|data (?:analyst|analytics|science|scientist|engineer\w*|engineering|platform)|analytics|business intelligence|bi|etl|machine learning|ciencia de dados|analise de dados|power ?bi|big data|dataops|analista de dados)\b/,
  'banco-de-dados': /\b(dba|bancos? de dados|database\w*|sql|nosql)\b/,
  seguranca:
    /\b(seguranca da informacao|ciberseguranca|seguranca cibernetica|cyber ?security|cyber|infosec|appsec|devsecops|pentest\w*|blue team|red team|soc (?:analyst|analista|n[123])|siem|gestao de vulnerabilidades|iam (?:analyst|analista|engineer)|identity (?:and|&) access|seguranca de (?:redes|aplicac\w+|sistemas|dados|ti))\b/,
  governanca:
    /\b(governanca de (?:ti|tecnologia|dados)|grc de ti|itil|cobit|gestao de servicos de ti|gestao de ti|auditoria de ti|riscos? de (?:ti|tecnologia)|compliance de (?:ti|tecnologia)|controles de ti|gestao de projetos de ti)\b/,
  'sistemas-corporativos':
    /\b(erp|sap|totvs|protheus|oracle (?:ebs|fusion|cloud erp)|dynamics|netsuite|sistemas corporativos|sistemas de gestao(?! (?:da |de |integrad|ambiental|qualidade))|suporte a erp|implantacao de (?:sistemas|erp)|analista de sistemas|analista funcional|key user)\b/,
  automacao:
    /\b(rpa|automacao de (?:processos|tarefas|fluxos)|automacao inteligente|uipath|power automate|low ?code|no ?code)\b/,
  'ti-geral':
    /\b(ti|t\.i\.?|tecnologia da informacao|informatica|computacao|sistemas de informacao|information technology)\b|\bintern\w*\b.*\bit\b|\bit\b.*\bintern\w*\b/,
};

/** Sinais FRACOS no título: sugerem TI, mas sozinhos não bastam (precisam da descrição). */
const WEAK_TITLE =
  /\b(tecnologia|technology|tech|digital|sistemas?|suporte|automacao|automation|implantacao|solucoes? digitais|inovacao|transformacao digital)\b/;

/**
 * Áreas de TI ou de negócio SEM sinal forte de TI no título. Um título só é "fora de TI" se não houver nenhum
 * sinal forte de TI; sinais fracos ("digital", "sistemas") não o protegem.
 */
const NON_IT =
  /\b(marketing|redes sociais|comercial|vendas?|sales|financ\w*|contab\w*|juridic\w*|rh|recursos humanos|people|atendimento|logistic\w*|administrativ\w*|customer (?:success|service|experience|support)|social media|conteudo|content|jornalis\w*|direito|ugc|creative|criativ\w*|audio|design|payroll|corporate desk|wealth|onboarding|workplace|compliance|operac\w*|operations|growth|brand|comunicacao|engenharia (?:de producao|civil|quimica|mecanica|eletrica|ambiental|de materiais|de alimentos|de minas|de petroleo)|manutencao|utilidades|obras|enfermagem|saude|psicologia|arquitetura|varejo|compras|suprimentos|projetos?|processos|equity research|credito|cobranca|tesouraria|investimentos?|private banking|middle office|back office|atuarial|previdencia|seguridade|rpps|poder publico|capacitacao|treinamento|recrutamento|talentos)\b/;

/**
 * Termos ESPECÍFICOS de atividade/requisito na descrição, por área. Palavras genéricas ("tecnologia", "software",
 * "digital") não entram: uma empresa de tecnologia não faz de toda função uma função de TI.
 */
const DESCRIPTION_TERMS: Record<JobArea, readonly string[]> = {
  desenvolvimento: [
    'javascript',
    'typescript',
    'python',
    'java',
    'c#',
    '.net',
    'react',
    'angular',
    'vue',
    'node',
    'apis? rest',
    'api',
    'programacao',
    'orientacao a objetos',
    'desenvolvimento de software',
    'backend',
    'frontend',
    'spring',
    'php',
    'kotlin',
    'swift',
  ],
  qa: [
    'casos de teste',
    'testes? de software',
    'testes? automatizados?',
    'selenium',
    'cypress',
    'playwright',
    'automacao de testes?',
    'homologacao',
    'qualidade de software',
    'bugs',
  ],
  suporte: [
    'help ?desk',
    'service ?desk',
    'chamados',
    'atendimento (?:ao|aos) usuarios?',
    'suporte tecnico',
    'suporte aos usuarios',
    'glpi',
    'active directory',
    'manutencao de computadores',
    'instalacao de (?:softwares?|programas)',
    'troubleshooting',
  ],
  infraestrutura: [
    'servidores',
    'redes',
    'linux',
    'windows server',
    'virtualizacao',
    'vmware',
    'cloud',
    'aws',
    'azure',
    'gcp',
    'docker',
    'kubernetes',
    'firewall',
    'monitoramento',
    'vpn',
  ],
  dados: [
    'power ?bi',
    'dashboards?',
    'etl',
    'analise de dados',
    'tableau',
    'data warehouse',
    'sql',
    'indicadores',
    'python',
  ],
  'banco-de-dados': [
    'sql',
    'bancos? de dados',
    'postgres\\w*',
    'mysql',
    'oracle',
    'sql server',
    'mongodb',
    'modelagem de dados',
    'dba',
  ],
  seguranca: [
    'vulnerabilidades',
    'siem',
    'firewall',
    'pentest\\w*',
    'iso 27001',
    'seguranca da informacao',
    'incidentes de seguranca',
    'antivirus',
    'iam',
  ],
  governanca: [
    'itil',
    'cobit',
    'iso 27001',
    'politicas de ti',
    'riscos de ti',
    'processos de ti',
    'indicadores de ti',
    'gestao de servicos',
    'auditoria de ti',
  ],
  'sistemas-corporativos': [
    'erp',
    'sap',
    'totvs',
    'protheus',
    'sistemas de gestao',
    'suporte a sistemas',
    'homologacao de sistemas',
    'levantamento de requisitos',
    'key user',
    'parametrizacao',
    'modulos',
  ],
  automacao: [
    'rpa',
    'automacao de processos',
    'uipath',
    'power automate',
    'fluxos automatizados',
    'scripts',
    'low ?code',
    'integracoes',
  ],
  'ti-geral': [],
};

const termRegex = (term: string): RegExp =>
  new RegExp(/^[a-z]/u.test(term) ? `\\b(?:${term})\\b` : `(?<![\\w])(?:${term})(?![\\w])`, 'u');
const COMPILED_TERMS: Record<JobArea, RegExp[]> = Object.fromEntries(
  JOB_AREAS.map((area) => [area, DESCRIPTION_TERMS[area].map(termRegex)]),
) as Record<JobArea, RegExp[]>;

/** Mínimo de termos específicos DISTINTOS na descrição para corroborar uma área. */
const CORROBORATION_MIN = 2;

export interface AreaClassification {
  /** Áreas com sinal forte no título. */
  fromTitle: JobArea[];
  /** Áreas corroboradas pela descrição (≥ 2 termos específicos distintos); só quando o título não tem sinal forte. */
  fromDescription: JobArea[];
  /** O título é de área fora de TI, sem sinal forte de TI e sem corroboração da descrição. */
  nonIt: boolean;
  /** O título tem só sinais fracos de TI ("tecnologia", "digital", "sistemas"...). */
  weakIt: boolean;
  /** O título tem palavras de área fora de TI, mas a descrição corrobora TI: conflito, vai para revisão. */
  conflict: boolean;
}

function matching(text: string): JobArea[] {
  return JOB_AREAS.filter((area) => TITLE_PATTERNS[area].test(text));
}

function corroborated(description: string): JobArea[] {
  const text = norm(description);
  return JOB_AREAS.filter(
    (area) => COMPILED_TERMS[area].filter((regex) => regex.test(text)).length >= CORROBORATION_MIN,
  );
}

export function classifyJobAreas(
  title: string,
  description: string | null | undefined,
): AreaClassification {
  const t = norm(title);
  let fromTitle = matching(t);
  // "TI (geral)" só vale sozinha: com uma área específica no título, a específica manda.
  if (fromTitle.length > 1) fromTitle = fromTitle.filter((area) => area !== 'ti-geral');
  if (fromTitle.length > 0)
    return { fromTitle, fromDescription: [], nonIt: false, weakIt: false, conflict: false };

  const weakIt = WEAK_TITLE.test(t);
  const titleNonIt = NON_IT.test(t);
  const fromDescription = description ? corroborated(description) : [];
  // Só a descrição, junto de um sinal fraco no título, desfaz um título de área de negócio (vai à revisão).
  const conflict = titleNonIt && weakIt && fromDescription.length > 0;
  const nonIt = titleNonIt && !conflict;
  return { fromTitle, fromDescription: nonIt ? [] : fromDescription, nonIt, weakIt, conflict };
}
