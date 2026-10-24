import type { Profile } from '../config/index.js';
import {
  AREA_LABELS,
  canonicalProfileAreas,
  classifyJobAreas,
  norm,
  type JobArea,
} from './areas.js';
import {
  courseCriteria,
  graduationCriteria,
  hoursCriteria,
  languageCriteria,
  semesterCriteria,
  startCriteria,
  technologyCriteria,
} from './requirements.js';
import { segmentDescription } from './segments.js';
import type {
  Criterion,
  EligibilityJob,
  EligibilityResult,
  EvaluateOptions,
  Verdict,
} from './types.js';

const BRAZIL = /(?:brasil|brazil|latam|latin america|sao paulo|\bbr\b)/;
const FOREIGN =
  /\b(?:us|usa|united states|uk|united kingdom|canada|europe|emea|apac|india|mexico|argentina|colombia|germany|france|spain|portugal|ireland|singapore|australia)\b/;
/** Região metropolitana de São Paulo: o deslocamento até lá não é presumido; precisa de tempo confirmado. */
export const GREATER_SP =
  /\b(?:osasco|guarulhos|barueri|santo andre|sao bernardo do campo|sao caetano do sul|diadema|taboao da serra|embu das artes|cotia|carapicuiba|itapevi|jandira|santana de parnaiba|mauá|maua|mogi das cruzes|suzano|ferraz de vasconcelos|poa|aruja|itaquaquecetuba|franco da rocha|caieiras|cajamar|arujá|ribeirao pires|rio grande da serra|itapecerica da serra|santo amaro|grande sao paulo|regiao metropolitana)\b/;
export const OTHER_CITIES =
  /\b(?:rio de janeiro|curitiba|belo horizonte|porto alegre|recife|florianopolis|campinas|brasilia|salvador|fortaleza|goiania|manaus|belem|vitoria|joinville|ribeirao preto|sao jose dos campos|santos|sorocaba)\b/;

const money = (value: number): string =>
  `R$ ${value.toLocaleString('pt-BR', { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;

function stipendCriterion(job: EligibilityJob, profile: Profile): Criterion {
  const minimum = profile.minStipend.amount;
  const base = { id: 'bolsa', kind: 'obrigatorio' } as const;
  const { stipendMin: low, stipendMax: high } = job;
  if (low === null && high === null) {
    return {
      ...base,
      outcome: 'indeterminado',
      detail:
        job.stipendText != null && job.stipendText !== ''
          ? `Bolsa sem valor mensal identificável ("${job.stipendText}"): pendente de análise, não descartada.`
          : 'Bolsa não informada: pendente de análise, não descartada.',
    };
  }
  if (job.stipendCurrency !== null && job.stipendCurrency !== profile.minStipend.currency) {
    return {
      ...base,
      outcome: 'indeterminado',
      detail: `Bolsa em ${job.stipendCurrency}; o mínimo do perfil é em ${profile.minStipend.currency}.`,
    };
  }
  const floor = low ?? high ?? 0;
  const ceiling = high ?? low ?? 0;
  if (floor >= minimum) {
    return {
      ...base,
      outcome: 'atende',
      detail: `Bolsa ${money(floor)} ≥ mínimo ${money(minimum)}.`,
    };
  }
  if (ceiling < minimum) {
    return {
      ...base,
      outcome: 'nao_atende',
      detail: `Bolsa ${money(ceiling)} < mínimo ${money(minimum)}.`,
    };
  }
  return {
    ...base,
    outcome: 'indeterminado',
    detail: `Faixa ${money(floor)} a ${money(ceiling)} cruza o mínimo de ${money(minimum)}: confirmar o valor.`,
  };
}

function areaCriterion(job: EligibilityJob, profile: Profile): Criterion {
  const base = { id: 'area', kind: 'obrigatorio' } as const;
  const wanted = canonicalProfileAreas(profile.areas);
  const classification = classifyJobAreas(job.title, job.description);
  const label = (areas: readonly JobArea[]): string =>
    areas.map((area) => AREA_LABELS[area]).join(', ');

  if (wanted.size === 0) {
    return { ...base, outcome: 'indeterminado', detail: 'O perfil não tem áreas reconhecidas.' };
  }
  if (classification.fromTitle.length > 0) {
    const hit = classification.fromTitle.filter((area) => wanted.has(area));
    return hit.length > 0
      ? { ...base, outcome: 'atende', detail: `Título indica ${label(hit)}, área do perfil.` }
      : {
          ...base,
          outcome: 'nao_atende',
          detail: `Título indica ${label(classification.fromTitle)}; fora das áreas do perfil.`,
        };
  }
  if (classification.nonIt) {
    return {
      ...base,
      outcome: 'nao_atende',
      detail: 'Título indica área fora de TI, sem sinal de TI no título nem na descrição.',
    };
  }
  if (classification.conflict) {
    return {
      ...base,
      outcome: 'indeterminado',
      detail: `Título de área de negócio, mas a descrição cita ${label(classification.fromDescription)}: confirmar se a função é de TI.`,
    };
  }
  if (classification.fromDescription.length > 0) {
    const hit = classification.fromDescription.filter((area) => wanted.has(area));
    if (classification.weakIt && hit.length > 0) {
      return {
        ...base,
        outcome: 'atende',
        detail: `Título sugere tecnologia e a descrição confirma ${label(hit)} (atividades e requisitos).`,
      };
    }
    return {
      ...base,
      outcome: 'indeterminado',
      detail: `Título sem área definida; a descrição cita ${label(classification.fromDescription)}: confirmar a área real da vaga.`,
    };
  }
  return {
    ...base,
    outcome: 'indeterminado',
    detail: classification.weakIt
      ? 'Título com sinal fraco de tecnologia e descrição sem atividades de TI identificáveis: confirmar.'
      : 'Não foi possível identificar a área da vaga.',
  };
}

function placeCriteria(job: EligibilityJob, profile: Profile): Criterion[] {
  const mode = job.workMode;
  if (mode === null) {
    return [
      {
        id: 'modalidade',
        kind: 'obrigatorio',
        outcome: 'indeterminado',
        detail: 'A vaga não informa a modalidade (remoto, híbrido ou presencial); não é presumida.',
      },
    ];
  }

  const { preferred, onsite } = profile.workModes;
  const accepted = new Set<string>(preferred);
  if (onsite.allowed) {
    accepted.add('presencial');
    accepted.add('hibrido');
  }
  const modeCriterion: Criterion = accepted.has(mode)
    ? {
        id: 'modalidade',
        kind: 'obrigatorio',
        outcome: 'atende',
        detail: `Modalidade ${mode} aceita pelo perfil.`,
      }
    : {
        id: 'modalidade',
        kind: 'obrigatorio',
        outcome: 'nao_atende',
        detail: `Modalidade ${mode} não é aceita pelo perfil.`,
      };
  if (modeCriterion.outcome === 'nao_atende') return [modeCriterion];

  const location = norm(job.location ?? '');
  const city = norm(profile.city).split(',')[0]?.trim() ?? '';
  const place = (outcome: Criterion['outcome'], detail: string): Criterion => ({
    id: 'localizacao',
    kind: 'obrigatorio',
    outcome,
    detail,
  });

  if (mode === 'remoto') {
    // Restrição de residência (ex.: "residir em Curitiba"): remoto no Brasil só vale se der para trabalhar de São Paulo.
    const residence = residenceRestriction(job, city);
    if (residence !== undefined) {
      return [
        modeCriterion,
        place(
          'indeterminado',
          `Remoto com possível exigência de residência (${residence}): confirmar se pode atuar de ${profile.city.split(',')[0] ?? 'São Paulo'}.`,
        ),
      ];
    }
    if (location === '' || BRAZIL.test(location)) {
      return [modeCriterion, place('atende', 'Remoto, sem restrição de local fora do Brasil.')];
    }
    if (FOREIGN.test(location)) {
      return [
        modeCriterion,
        place(
          'indeterminado',
          `Remoto com local "${job.location}": possível restrição geográfica; confirmar.`,
        ),
      ];
    }
    return [modeCriterion, place('atende', 'Remoto, sem restrição de local identificada.')];
  }

  // híbrido ou presencial: precisa ser na cidade do perfil (ou local com tempo confirmado), e o deslocamento verificável.
  if (location === '') {
    return [modeCriterion, place('indeterminado', `Vaga ${mode} sem local informado.`)];
  }
  if (city !== '' && location.includes(city)) {
    return [
      modeCriterion,
      place('atende', `Local em ${profile.city.split(',')[0]}.`),
      commuteCriterion(job, profile),
    ];
  }
  if (commuteMatches(job, profile).length > 0) {
    return [
      modeCriterion,
      place('atende', `Local "${job.location}" consta entre os tempos confirmados no perfil.`),
      commuteCriterion(job, profile),
    ];
  }
  if (OTHER_CITIES.test(location)) {
    return [
      modeCriterion,
      place('nao_atende', `Vaga ${mode} em "${job.location}", fora de ${profile.city}.`),
    ];
  }
  if (GREATER_SP.test(location)) {
    return [
      modeCriterion,
      place(
        'indeterminado',
        `Local "${job.location}" na região metropolitana: o deslocamento não é presumido; confirme o tempo (comando "locais registrar").`,
      ),
    ];
  }
  return [
    modeCriterion,
    place(
      'indeterminado',
      `Local "${job.location}" não permite confirmar se é em ${profile.city}.`,
    ),
  ];
}

const RESIDENCE =
  /\b(?:residir|morar|reside|residente|moradores?|candidatos? (?:de|em|da|do|residentes))\s+(?:em|na|no|de|da|do)?\s*([a-z][a-z ]{2,40}?)(?:[.,;:)\n]|\se\b|$)/;
const SAO_PAULO_OK = /\b(?:sao paulo|sp|brasil|brazil|qualquer (?:lugar|regiao|cidade))\b/;

/** Texto da vaga exigindo residência fora de São Paulo? Devolve o trecho (mascarado a 40 caracteres) ou undefined. */
function residenceRestriction(job: EligibilityJob, city: string): string | undefined {
  const text = norm(`${job.location ?? ''}\n${job.description ?? ''}`);
  const match = RESIDENCE.exec(text);
  if (match === null) return undefined;
  const place = (match[1] ?? '').trim();
  if (place === '' || SAO_PAULO_OK.test(place) || (city !== '' && place.includes(city)))
    return undefined;
  return place.slice(0, 40);
}

export function commuteMatches(job: EligibilityJob, profile: Profile) {
  const haystack = norm(`${job.company ?? ''} ${job.location ?? ''}`);
  return (profile.commute ?? []).filter((entry) =>
    entry.keywords.some((keyword) =>
      new RegExp(`\\b${norm(keyword).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(haystack),
    ),
  );
}

function commuteCriterion(job: EligibilityJob, profile: Profile): Criterion {
  const limit = profile.workModes.onsite.maxCommuteMinutesPerWay;
  const reviewLimit = profile.workModes.onsite.reviewMaxCommuteMinutesPerWay ?? limit + 10;
  const matches = commuteMatches(job, profile);
  const base = { id: 'deslocamento', kind: 'obrigatorio' } as const;
  const origin = profile.home?.label === undefined ? '' : ` a partir de ${profile.home.label}`;
  if (matches.length === 0) {
    return {
      ...base,
      outcome: 'indeterminado',
      detail: `Deslocamento não verificável${origin}: "${job.location ?? ''}" não consta nos tempos confirmados no perfil (adequado até ${limit} min por trecho; confirme com "locais registrar").`,
    };
  }
  // Mais de um local casando: vale o pior caso.
  const worst = matches.reduce((a, b) => (a.minutesPerWay >= b.minutesPerWay ? a : b));
  const when = worst.confirmedAt === undefined ? '' : `, confirmado em ${worst.confirmedAt}`;
  const where = `${worst.minutesPerWay} min por trecho${origin}; fonte: ${worst.source}${when}`;
  if (worst.minutesPerWay <= limit)
    return {
      ...base,
      outcome: 'atende',
      detail: `Deslocamento verificado: ${where} (adequado até ${limit}).`,
    };
  if (worst.minutesPerWay <= reviewLimit)
    return {
      ...base,
      outcome: 'indeterminado',
      detail: `Deslocamento limítrofe: ${where} (${limit + 1} a ${reviewLimit} min: revisão manual).`,
    };
  return {
    ...base,
    outcome: 'nao_atende',
    detail: `Deslocamento verificado: ${where}; acima de ${reviewLimit} min, normalmente incompatível.`,
  };
}

function decide(
  criteria: readonly Criterion[],
  approved: boolean,
): { verdict: Verdict; reasons: string[] } {
  const mandatory = criteria.filter((criterion) => criterion.kind === 'obrigatorio');
  const failed = mandatory.filter((criterion) => criterion.outcome === 'nao_atende');
  const unknown = mandatory.filter((criterion) => criterion.outcome === 'indeterminado');

  if (!approved) {
    return {
      verdict: 'revisao_humana',
      reasons: [
        'Perfil ainda não aprovado a partir do currículo de referência: nenhuma vaga pode ser considerada apta ou inapta.',
        ...failed.map((c) => `(provisório) ${c.detail}`),
        ...unknown.filter((c) => c.id !== 'perfil').map((c) => c.detail),
      ],
    };
  }
  if (failed.length > 0) return { verdict: 'inapto', reasons: failed.map((c) => c.detail) };
  if (unknown.length > 0)
    return { verdict: 'revisao_humana', reasons: unknown.map((c) => c.detail) };
  return {
    verdict: 'apto',
    reasons: ['Todos os requisitos obrigatórios verificáveis são atendidos.'],
  };
}

/**
 * Classifica uma vaga em apto, inapto ou revisão humana, com os critérios que levaram ao
 * resultado. Só reprova (`inapto`) por requisito obrigatório comprovadamente não atendido; dado
 * ausente do perfil ou da vaga leva a revisão humana. Diferenciais nunca alteram o veredito.
 */
export function evaluateJob(
  profile: Profile,
  job: EligibilityJob,
  options: EvaluateOptions = {},
): EligibilityResult {
  const now = options.now ?? new Date();
  const segments = job.description ? segmentDescription(job.description) : [];

  const criteria: Criterion[] = [
    areaCriterion(job, profile),
    stipendCriterion(job, profile),
    ...placeCriteria(job, profile),
    ...courseCriteria(segments, profile),
    ...semesterCriteria(segments, profile),
    ...graduationCriteria(segments, profile),
    ...languageCriteria(segments, profile),
    ...hoursCriteria(segments, profile),
    ...startCriteria(segments, profile, now),
    ...technologyCriteria(segments, profile),
  ];

  const approved = profile.approval !== undefined;
  criteria.unshift({
    id: 'perfil',
    kind: 'obrigatorio',
    outcome: approved ? 'atende' : 'indeterminado',
    detail: approved
      ? `Perfil aprovado em ${profile.approval?.approvedAt} (currículo ${profile.approval?.cvFile}).`
      : 'Perfil não aprovado: faltam a extração e a confirmação dos dados a partir do currículo.',
  });

  const differential = criteria.filter((criterion) => criterion.kind === 'diferencial');
  const { verdict, reasons } = decide(criteria, approved);
  return {
    verdict,
    reasons,
    criteria,
    differentials: {
      matched: differential.filter((criterion) => criterion.outcome === 'atende').length,
      total: differential.length,
    },
  };
}
