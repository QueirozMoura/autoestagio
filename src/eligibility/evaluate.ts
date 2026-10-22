import type { Profile } from '../config/index.js';
import { AREA_LABELS, canonicalProfileAreas, classifyJobAreas, norm } from './areas.js';
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
const OTHER_CITIES =
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
  const label = (areas: readonly (keyof typeof AREA_LABELS)[]): string =>
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
    return { ...base, outcome: 'nao_atende', detail: 'Título indica área fora de TI.' };
  }
  if (classification.fromDescription.length > 0) {
    return {
      ...base,
      outcome: 'indeterminado',
      detail: `Título sem área definida; a descrição cita ${label(classification.fromDescription)}: confirmar a área real da vaga.`,
    };
  }
  return {
    ...base,
    outcome: 'indeterminado',
    detail: classification.genericIt
      ? 'Vaga de tecnologia sem área específica identificável.'
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

  // híbrido ou presencial: precisa ser na cidade do perfil, e o deslocamento precisa ser verificável.
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
  if (OTHER_CITIES.test(location)) {
    return [
      modeCriterion,
      place('nao_atende', `Vaga ${mode} em "${job.location}", fora de ${profile.city}.`),
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

function commuteCriterion(job: EligibilityJob, profile: Profile): Criterion {
  const limit = profile.workModes.onsite.maxCommuteMinutesPerWay;
  const haystack = norm(`${job.company ?? ''} ${job.location ?? ''}`);
  const matches = (profile.commute ?? []).filter((entry) =>
    entry.keywords.some((keyword) =>
      new RegExp(`\\b${norm(keyword).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(haystack),
    ),
  );
  const base = { id: 'deslocamento', kind: 'obrigatorio' } as const;
  if (matches.length === 0) {
    return {
      ...base,
      outcome: 'indeterminado',
      detail: `Deslocamento não verificável: "${job.location ?? ''}" não consta nos tempos confirmados no perfil (limite ${limit} min por trecho).`,
    };
  }
  // Mais de um local casando: vale o pior caso.
  const worst = matches.reduce((a, b) => (a.minutesPerWay >= b.minutesPerWay ? a : b));
  return {
    ...base,
    outcome: worst.minutesPerWay <= limit ? 'atende' : 'nao_atende',
    detail: `Deslocamento verificado: ${worst.minutesPerWay} min por trecho (limite ${limit}); fonte: ${worst.source}.`,
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
