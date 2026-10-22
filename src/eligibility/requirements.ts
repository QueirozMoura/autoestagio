import type { LanguageLevel, Profile } from '../config/index.js';
import { LANGUAGE_LEVELS } from '../config/index.js';
import { norm } from './areas.js';
import { strengthOf, type Segment } from './segments.js';
import type { Criterion, Outcome } from './types.js';

/**
 * Extratores de requisitos do texto da vaga. Cada um devolve critérios com o trecho de origem.
 * Regra geral: se o texto é ambíguo ou o perfil não informa o dado, o resultado é
 * `indeterminado` (revisão humana), nunca uma suposição.
 */

const clip = (text: string): string => (text.length > 160 ? `${text.slice(0, 157)}...` : text);
const rank = (level: LanguageLevel): number => LANGUAGE_LEVELS.indexOf(level);
const LEVEL_LABEL: Record<LanguageLevel, string> = {
  nenhum: 'nenhum',
  basico: 'básico',
  intermediario: 'intermediário',
  avancado: 'avançado',
  fluente: 'fluente',
};

// ---------------------------------------------------------------- idioma

const LANGUAGES: readonly (readonly [RegExp, string])[] = [
  [/\b(?:ingles|english)\b/, 'inglês'],
  [/\b(?:espanhol|spanish)\b/, 'espanhol'],
];
const LANGUAGE_KEYS: Record<string, string> = {
  ingles: 'inglês',
  english: 'inglês',
  espanhol: 'espanhol',
  spanish: 'espanhol',
};
const LEVEL_PATTERNS: readonly (readonly [RegExp, LanguageLevel])[] = [
  [/\b(?:fluente|fluent|fluencia|bilingue|proficiente?|proficiency)\b/, 'fluente'],
  [/\b(?:avancado|advanced|c1|c2)\b/, 'avancado'],
  [/\b(?:intermediario|intermediate|conversacao|conversational|b1|b2)\b/, 'intermediario'],
  [/\b(?:basico|basic|elementary|leitura tecnica|a1|a2)\b/, 'basico'],
];
const NOT_REQUIRED =
  /\b(?:nao (?:e |eh )?(?:exig\w+|obrigatori\w+|necessari\w+)|sem (?:necessidade|exigencia)|nao precisa|dispensa\w*)\b/;
const BENEFIT = /\b(?:aulas?|cursos?|subsidio|auxilio|gympass|beneficios?|bolsa de idiomas?)\b/;

export function languageLevelsIn(text: string): LanguageLevel[] {
  return LEVEL_PATTERNS.filter(([pattern]) => pattern.test(text)).map(([, level]) => level);
}

function profileEntry(profile: Profile, language: string) {
  return profile.languages?.find((entry) => LANGUAGE_KEYS[norm(entry.language)] === language);
}

/** A exigência fala de uso oral (conversação, fluência) ou de leitura/documentação? */
const ORAL =
  /\b(?:conversac\w*|falad\w*|oral|speaking|speak|fala|fluente|fluent|fluencia|bilingue|reunioes?)\b/;
const READING = /\b(?:leitura|reading|read|documentacao|documentation|artigos?)\b/;
type Skill = 'oral' | 'leitura' | 'geral';
function skillOf(text: string): Skill {
  if (ORAL.test(text)) return 'oral';
  if (READING.test(text)) return 'leitura';
  return 'geral';
}

export function languageCriteria(segments: readonly Segment[], profile: Profile): Criterion[] {
  interface Found {
    kind: 'obrigatorio' | 'diferencial';
    weak: boolean;
    level: LanguageLevel | undefined;
    skill: Skill;
    evidence: string;
  }
  const found = new Map<string, Found>();

  for (const segment of segments) {
    const strength = strengthOf(segment, false);
    if (strength === 'ignorar' || NOT_REQUIRED.test(segment.norm) || BENEFIT.test(segment.norm)) {
      continue;
    }
    for (const [pattern, language] of LANGUAGES) {
      if (!pattern.test(segment.norm)) continue;
      const levels = languageLevelsIn(segment.norm);
      // "intermediário ou avançado": o mínimo aceito é o menor nível citado.
      const level =
        levels.length === 0 ? undefined : levels.reduce((a, b) => (rank(a) <= rank(b) ? a : b));
      const kind = strength === 'diferencial' ? 'diferencial' : 'obrigatorio';
      const key = `${language}|${kind}|${strength === 'fraco'}`;
      const previous = found.get(key);
      if (
        previous === undefined ||
        (level !== undefined &&
          (previous.level === undefined || rank(level) > rank(previous.level)))
      ) {
        found.set(key, {
          kind,
          weak: strength === 'fraco',
          level,
          skill: skillOf(segment.norm),
          evidence: segment.text,
        });
      }
    }
  }

  const criteria: Criterion[] = [];
  for (const [key, entry] of found) {
    const language = key.split('|')[0] ?? '';
    const known = profileEntry(profile, language);
    const have = known?.level;
    const label =
      entry.level === undefined
        ? `${language} (nível não especificado)`
        : `${language} ${LEVEL_LABEL[entry.level]}`;
    let outcome: Outcome;
    let detail: string;
    if (have === undefined) {
      outcome = 'indeterminado';
      detail = `Vaga cita ${label}; o perfil aprovado não informa nível de ${language}.`;
    } else if (known?.scope === 'leitura-tecnica') {
      // O perfil só comprova leitura técnica: conversação/escrita nunca são presumidas.
      const mine = `${language} ${LEVEL_LABEL[have]} (apenas leitura técnica)`;
      if (entry.skill === 'oral') {
        outcome = 'indeterminado';
        detail = `Vaga: ${label} em uso oral; perfil: ${mine}, conversação não comprovada.`;
      } else if (entry.level !== undefined && rank(have) < rank(entry.level)) {
        outcome = 'nao_atende';
        detail = `Vaga: ${label}; perfil: ${mine}, abaixo do exigido até para leitura.`;
      } else if (entry.skill === 'leitura') {
        outcome = rank(have) >= rank('basico') ? 'atende' : 'indeterminado';
        detail = `Vaga: ${label} para leitura; perfil: ${mine}.`;
      } else {
        outcome = 'indeterminado';
        detail = `Vaga: ${label} sem dizer o uso (leitura ou conversação); perfil: ${mine}.`;
      }
    } else if (entry.level === undefined) {
      outcome = rank(have) >= rank('intermediario') ? 'atende' : 'indeterminado';
      detail = `Vaga cita ${label}; perfil: ${language} ${LEVEL_LABEL[have]}.`;
    } else {
      outcome = rank(have) >= rank(entry.level) ? 'atende' : 'nao_atende';
      detail = `Vaga: ${label}; perfil: ${language} ${LEVEL_LABEL[have]}.`;
    }
    if (entry.weak) {
      // Menção sem contexto claro de exigência: pode confirmar, mas nunca reprova sozinha.
      if (outcome === 'nao_atende') outcome = 'indeterminado';
      detail += ' Menção fora de uma seção de requisitos: confirmar se é exigida.';
    }
    criteria.push({
      id: 'idioma',
      kind: entry.kind,
      outcome,
      detail,
      evidence: clip(entry.evidence),
    });
  }
  return criteria;
}

// ---------------------------------------------------------------- curso

const COURSE_TRIGGER =
  /\b(?:cursando|graduando|graduacao|estudante|universitari\w*|ensino superior|curso superior|matriculad\w*|bacharelado|tecnologo|pos-?graduacao|mestrado|doutorado|mba|phd)\b/;
const POSTGRAD = /\b(?:pos-?graduacao|mestrado|doutorado|mba|phd)\b/;
const COMPUTING =
  /(?:computacao|sistemas de informacao|analise e desenvolvimento de sistemas|\bads\b|engenharia de software|engenharia de dados|tecnologia da informacao|\bti\b|redes de computadores|ciencia de dados|banco de dados|seguranca da informacao|jogos digitais|sistemas para internet|informatica|inteligencia artificial|desenvolvimento de software)/;
const COURSE_TERMS: readonly (readonly [RegExp, string])[] = [
  [/ciencias? da computacao|computer science/, 'ciência da computação'],
  [/engenharia (?:de software|da computacao)/, 'engenharia de software/computação'],
  [/sistemas de informacao/, 'sistemas de informação'],
  [/analise e desenvolvimento de sistemas|\bads\b/, 'análise e desenvolvimento de sistemas'],
  [/tecnologia da informacao|\bti\b/, 'tecnologia da informação'],
  [/redes de computadores/, 'redes de computadores'],
  [/ciencia de dados/, 'ciência de dados'],
  [/engenharia(?! de software| da computacao| de dados)/, 'engenharia'],
  [/matematica|estatistica|fisica/, 'exatas'],
];
const RELATED =
  /\b(?:areas? (?:afins?|correlatas?|relacionadas?|similares?)|afins?|correlat[oa]s?)\b/;

export function courseCriteria(segments: readonly Segment[], profile: Profile): Criterion[] {
  const course = norm(profile.education.course);
  const profileComputing = COMPUTING.test(course);
  const criteria: Criterion[] = [];

  for (const segment of segments) {
    if (!COURSE_TRIGGER.test(segment.norm)) continue;
    const strength = strengthOf(segment, true);
    if (strength === 'ignorar' || strength === 'fraco') continue;
    const kind = strength === 'diferencial' ? 'diferencial' : 'obrigatorio';
    const evidence = clip(segment.text);

    if (POSTGRAD.test(segment.norm)) {
      criteria.push({
        id: 'curso',
        kind,
        outcome: 'nao_atende',
        detail: 'Vaga exige pós-graduação/mestrado/MBA; o perfil é de graduação em andamento.',
        evidence,
      });
      continue;
    }

    const named = COURSE_TERMS.filter(([pattern]) => pattern.test(segment.norm)).map(
      ([, name]) => name,
    );
    const related = RELATED.test(segment.norm);
    const exact = COURSE_TERMS.some(
      ([pattern]) => pattern.test(segment.norm) && pattern.test(course),
    );
    let outcome: Outcome;
    let detail: string;
    if (exact) {
      outcome = 'atende';
      detail = `Curso do perfil (${profile.education.course}) consta entre os citados.`;
    } else if (related && profileComputing) {
      outcome = 'atende';
      detail = `Vaga aceita áreas afins; o curso do perfil (${profile.education.course}) é da área de computação.`;
    } else if (named.length === 0) {
      outcome = 'atende';
      detail = 'Vaga pede apenas ensino superior em andamento, sem curso específico.';
    } else {
      outcome = 'indeterminado';
      detail = `Cursos citados: ${named.join(', ')}; o curso do perfil (${profile.education.course}) não consta e a vaga não menciona áreas afins.`;
    }
    criteria.push({ id: 'curso', kind, outcome, detail, evidence });
  }
  return mergeById(criteria, 'curso');
}

/** Vários trechos sobre o mesmo critério viram um só: o pior resultado obrigatório prevalece. */
function mergeById(criteria: Criterion[], id: Criterion['id']): Criterion[] {
  const same = criteria.filter((criterion) => criterion.id === id);
  if (same.length <= 1) return criteria;
  const order: Outcome[] = ['nao_atende', 'indeterminado', 'atende'];
  const byKind = (kind: Criterion['kind']): Criterion[] => {
    const group = same.filter((criterion) => criterion.kind === kind);
    if (group.length === 0) return [];
    const worst = [...group].sort((a, b) => order.indexOf(a.outcome) - order.indexOf(b.outcome))[0];
    return worst ? [worst] : [];
  };
  return [
    ...criteria.filter((criterion) => criterion.id !== id),
    ...byKind('obrigatorio'),
    ...byKind('diferencial'),
  ];
}

// ---------------------------------------------------------------- semestre e formatura

const ORD = '[ºo°]?';

export function semesterCriteria(segments: readonly Segment[], profile: Profile): Criterion[] {
  const semester = profile.education.currentSemester;
  const criteria: Criterion[] = [];
  for (const segment of segments) {
    const strength = strengthOf(segment, true);
    if (strength === 'ignorar' || strength === 'fraco') continue;
    let min: number | undefined;
    let max: number | undefined;

    const range = new RegExp(
      `(\\d{1,2})\\s*${ORD}\\s*(?:semestre)?\\s*(?:ao|a|e|ate o|ate|-)\\s*(?:o\\s*)?(\\d{1,2})\\s*${ORD}\\s*semestre`,
    ).exec(segment.norm);
    const from = new RegExp(`a partir d[oe]\\s*(\\d{1,2})\\s*${ORD}\\s*semestre`).exec(
      segment.norm,
    );
    const upTo = new RegExp(`(?:ate|no maximo)\\s*(?:o\\s*)?(\\d{1,2})\\s*${ORD}\\s*semestre`).exec(
      segment.norm,
    );
    if (range) {
      min = Number(range[1]);
      max = Number(range[2]);
    } else if (from) {
      min = Number(from[1]);
    } else if (upTo) {
      max = Number(upTo[1]);
    } else continue;

    const wanted = `${min ?? 1}º${max === undefined ? ' em diante' : ` ao ${max}º`} semestre`;
    let outcome: Outcome;
    let detail: string;
    if (semester === undefined) {
      outcome = 'indeterminado';
      detail = `Vaga exige ${wanted}; o perfil aprovado não informa o semestre atual.`;
    } else if (semester >= (min ?? 1) && (max === undefined || semester <= max)) {
      outcome = 'atende';
      detail = `Vaga: ${wanted}; perfil: ${semester}º semestre.`;
    } else {
      outcome = 'nao_atende';
      detail = `Vaga: ${wanted}; perfil: ${semester}º semestre.`;
    }
    criteria.push({
      id: 'semestre',
      kind: strength === 'diferencial' ? 'diferencial' : 'obrigatorio',
      outcome,
      detail,
      evidence: clip(segment.text),
    });
  }
  return mergeById(criteria, 'semestre');
}

const GRADUATION =
  /\b(?:formatura|conclusao|termino|formacao|previsao de (?:formatura|conclusao|termino)|formando)\b/;

export function graduationCriteria(segments: readonly Segment[], profile: Profile): Criterion[] {
  const year = profile.education.expectedGraduationYear;
  const criteria: Criterion[] = [];
  for (const segment of segments) {
    const strength = strengthOf(segment, true);
    if (strength === 'ignorar' || strength === 'fraco') continue;
    if (!GRADUATION.test(segment.norm)) continue;
    const years = [...segment.norm.matchAll(/\b(20\d{2})\b/g)].map((m) => Number(m[1]));
    if (years.length === 0) continue;

    const first = years[0] ?? year;
    let ok: boolean;
    let wanted: string;
    if (years.length >= 2 && /\b(?:entre|e|a|ate)\b/.test(segment.norm)) {
      const low = Math.min(first, years[1] ?? first);
      const high = Math.max(first, years[1] ?? first);
      ok = year >= low && year <= high;
      wanted = `entre ${low} e ${high}`;
    } else if (/\b(?:ate|no maximo)\b/.test(segment.norm)) {
      ok = year <= first;
      wanted = `até ${first}`;
    } else if (/\b(?:a partir de|apos|depois de)\b/.test(segment.norm)) {
      ok = year >= first;
      wanted = `a partir de ${first}`;
    } else {
      ok = year === first;
      wanted = `em ${first}`;
    }
    criteria.push({
      id: 'formatura',
      kind: strength === 'diferencial' ? 'diferencial' : 'obrigatorio',
      outcome: ok ? 'atende' : 'nao_atende',
      detail: `Vaga: formatura ${wanted}; perfil: previsão em ${year} (comparação por ano).`,
      evidence: clip(segment.text),
    });
  }
  return mergeById(criteria, 'formatura');
}

// ---------------------------------------------------------------- disponibilidade

export function hoursCriteria(segments: readonly Segment[], profile: Profile): Criterion[] {
  const availability = profile.availability;
  const criteria: Criterion[] = [];
  for (const segment of segments) {
    const strength = strengthOf(segment, true);
    if (strength === 'ignorar' || strength === 'fraco') continue;
    let low: number;
    let high: number;
    let basis: string;

    const weeklyRange =
      /(\d{1,2})\s*(?:a|-|ate|e)\s*(\d{1,2})\s*(?:h|horas?)\s*(?:semanais|\/\s*semana|por semana|na semana)/.exec(
        segment.norm,
      );
    const weekly = /(\d{1,2})\s*(?:h|horas?)\s*(?:semanais|\/\s*semana|por semana|na semana)/.exec(
      segment.norm,
    );
    const daily = /(\d{1,2})\s*(?:h|horas?)\s*(?:diarias|\/\s*dia|por dia|ao dia)/.exec(
      segment.norm,
    );
    if (weeklyRange) {
      low = Number(weeklyRange[1]);
      high = Number(weeklyRange[2]);
      basis = `${low} a ${high} horas semanais`;
    } else if (weekly) {
      low = high = Number(weekly[1]);
      basis = `${low} horas semanais`;
    } else if (daily) {
      low = high = Number(daily[1]) * 5;
      basis = `${daily[1]} horas diárias (≈ ${low} semanais, 5 dias)`;
    } else continue;

    let outcome: Outcome;
    let detail: string;
    if (availability === undefined) {
      outcome = 'indeterminado';
      detail = `Vaga: ${basis}; o perfil aprovado não informa a disponibilidade semanal.`;
    } else {
      const { min, max } = availability.hoursPerWeek;
      const overlaps = low <= max && high >= min;
      outcome = overlaps ? 'atende' : 'nao_atende';
      detail = `Vaga: ${basis}; perfil disponível de ${min} a ${max} horas semanais.`;
    }
    criteria.push({
      id: 'carga-horaria',
      kind: strength === 'diferencial' ? 'diferencial' : 'obrigatorio',
      outcome,
      detail,
      evidence: clip(segment.text),
    });
  }
  return mergeById(criteria, 'carga-horaria');
}

const MONTHS = [
  'janeiro',
  'fevereiro',
  'marco',
  'abril',
  'maio',
  'junho',
  'julho',
  'agosto',
  'setembro',
  'outubro',
  'novembro',
  'dezembro',
];

export function startCriteria(
  segments: readonly Segment[],
  profile: Profile,
  now: Date,
): Criterion[] {
  const availability = profile.availability;
  const criteria: Criterion[] = [];
  for (const segment of segments) {
    const strength = strengthOf(segment, true);
    if (strength === 'ignorar' || strength === 'fraco') continue;
    const kind = strength === 'diferencial' ? 'diferencial' : 'obrigatorio';

    let deadline: Date | undefined;
    let wanted: string;
    if (
      /\b(?:inicio imediato|disponibilidade imediata|immediate start|start immediately|imediato)\b/.test(
        segment.norm,
      )
    ) {
      deadline = now;
      wanted = 'início imediato';
    } else {
      const month = new RegExp(
        `\\b(?:inicio|comeco|start|ingresso)\\b[^.;]{0,40}?\\b(${MONTHS.join('|')})(?:\\s*(?:de|/|-)?\\s*(20\\d{2}))?`,
      ).exec(segment.norm);
      if (!month) continue;
      if (month[2] === undefined) {
        criteria.push({
          id: 'inicio',
          kind,
          outcome: 'indeterminado',
          detail: `Vaga cita início em ${month[1]} sem informar o ano.`,
          evidence: clip(segment.text),
        });
        continue;
      }
      const monthIndex = MONTHS.indexOf(month[1] ?? '');
      deadline = new Date(Date.UTC(Number(month[2]), monthIndex + 1, 0, 23, 59, 59));
      wanted = `início em ${month[1]} de ${month[2]}`;
    }

    let outcome: Outcome;
    let detail: string;
    if (availability === undefined) {
      outcome = 'indeterminado';
      detail = `Vaga: ${wanted}; o perfil aprovado não informa a data em que pode começar.`;
    } else {
      outcome =
        new Date(`${availability.startFrom}T00:00:00Z`) <= deadline ? 'atende' : 'nao_atende';
      detail = `Vaga: ${wanted}; perfil pode começar a partir de ${availability.startFrom}.`;
    }
    criteria.push({ id: 'inicio', kind, outcome, detail, evidence: clip(segment.text) });
  }
  return mergeById(criteria, 'inicio');
}

// ---------------------------------------------------------------- tecnologias

const TECHNOLOGIES: readonly (readonly [string, RegExp])[] = [
  ['TypeScript', /\btypescript\b/],
  ['JavaScript', /\bjavascript\b/],
  ['React', /\breact(?:\.?js)?\b/],
  ['Node.js', /\bnode(?:\.?js)?\b/],
  ['Python', /\bpython\b/],
  ['Java', /\bjava\b/],
  ['C#', /(?:^|[^a-z0-9])c#/],
  ['.NET', /(?:^|[^a-z0-9])\.net\b/],
  ['C++', /(?:^|[^a-z0-9])c\+\+/],
  ['SQL', /\bsql\b/],
  ['PostgreSQL', /\bpostgres(?:ql)?\b/],
  ['MySQL', /\bmysql\b/],
  ['MongoDB', /\bmongo(?:db)?\b/],
  ['Git', /\bgit(?:hub|lab)?\b/],
  ['Docker', /\bdocker\b/],
  ['AWS', /\baws\b/],
  ['Azure', /\bazure\b/],
  ['GCP', /\b(?:gcp|google cloud)\b/],
  ['Linux', /\blinux\b/],
  ['Kubernetes', /\b(?:kubernetes|k8s)\b/],
  ['PHP', /\bphp\b/],
  ['Go', /\bgolang\b/],
  ['Ruby', /\bruby\b/],
  ['Angular', /\bangular\b/],
  ['Vue', /\bvue(?:\.?js)?\b/],
  ['Next.js', /\bnext(?:\.?js)\b/],
  ['Spring', /\bspring\b/],
  ['Django', /\bdjango\b/],
  ['Excel', /\bexcel\b/],
  ['Power BI', /\bpower ?bi\b/],
  ['Tableau', /\btableau\b/],
  ['Selenium', /\bselenium\b/],
  ['Cypress', /\bcypress\b/],
  ['Playwright', /\bplaywright\b/],
  ['Jest', /\bjest\b/],
  ['Vitest', /\bvitest\b/],
  ['Postman', /\bpostman\b/],
  ['Terraform', /\bterraform\b/],
  ['Express', /\bexpress(?:\.?js)?\b/],
  ['Fastify', /\bfastify\b/],
  ['Prisma', /\bprisma\b/],
];

/** Tecnologias conhecidas citadas no texto (vocabulário fechado; o resto é ignorado). */
export function technologiesIn(text: string): Set<string> {
  const n = norm(text);
  return new Set(TECHNOLOGIES.filter(([, pattern]) => pattern.test(n)).map(([name]) => name));
}

export function technologyCriteria(segments: readonly Segment[], profile: Profile): Criterion[] {
  const have = new Set<string>();
  for (const technology of profile.technologies) {
    for (const name of technologiesIn(technology)) have.add(name);
  }
  const required = new Map<string, string>();
  const optional = new Map<string, string>();
  for (const segment of segments) {
    const strength = strengthOf(segment, false);
    if (strength !== 'obrigatorio' && strength !== 'diferencial') continue;
    const target = strength === 'obrigatorio' ? required : optional;
    for (const name of technologiesIn(segment.text)) {
      if (!target.has(name)) target.set(name, segment.text);
    }
  }

  const criteria: Criterion[] = [];
  const missing = [...required.keys()].filter((name) => !have.has(name));
  if (required.size > 0) {
    criteria.push({
      id: 'tecnologia',
      kind: 'obrigatorio',
      outcome: missing.length === 0 ? 'atende' : 'indeterminado',
      detail:
        missing.length === 0
          ? `Tecnologias exigidas presentes no perfil: ${[...required.keys()].join(', ')}.`
          : `Exigidas e ausentes do perfil aprovado: ${missing.join(', ')} (conhecimento não é presumido; revisar).`,
      evidence: clip([...required.values()][0] ?? ''),
    });
  }
  if (optional.size > 0) {
    const matched = [...optional.keys()].filter((name) => have.has(name));
    criteria.push({
      id: 'tecnologia',
      kind: 'diferencial',
      outcome: matched.length > 0 ? 'atende' : 'nao_atende',
      detail: `Diferenciais presentes no perfil: ${matched.length}/${optional.size}${matched.length > 0 ? ` (${matched.join(', ')})` : ''}.`,
    });
  }
  return criteria;
}
