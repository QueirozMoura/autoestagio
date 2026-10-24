import { parseProfile, type Profile } from '../../src/config/index.js';
import type { Criterion, CriterionId, EligibilityJob } from '../../src/eligibility/index.js';

/** Perfil FICTÍCIO e aprovado, só para testes. Nada aqui descreve a pessoa real. */
export const baseProfile: Record<string, unknown> = {
  name: 'Pessoa Exemplo',
  city: 'São Paulo, SP',
  education: {
    course: 'Análise e Desenvolvimento de Sistemas',
    institution: 'Faculdade Exemplo',
    expectedGraduationYear: 2028,
    degreeType: 'tecnologo',
    currentSemester: 3,
  },
  level: 'estagio',
  areas: ['todas'],
  technologies: ['TypeScript', 'SQL', 'Git'],
  languages: [{ language: 'Inglês', level: 'intermediario' }],
  availability: { hoursPerWeek: { min: 20, max: 30 }, startFrom: '2026-12-01' },
  commute: [{ keywords: ['pinheiros'], minutesPerWay: 45, source: 'fictício, para testes' }],
  workModes: {
    preferred: ['remoto', 'hibrido'],
    onsite: { allowed: true, maxCommuteMinutesPerWay: 70 },
  },
  minStipend: { amount: 1200, currency: 'BRL', whenUnknown: 'pendente' },
  approval: {
    cvFile: 'curriculo-ficticio.pdf',
    cvSha256: 'a'.repeat(64),
    approvedAt: '2026-10-22',
  },
};

export function profile(overrides: Record<string, unknown> = {}): Profile {
  return parseProfile({ ...baseProfile, ...overrides });
}

/** Vaga fictícia que, com o perfil acima, é apta; cada teste altera só o que quer exercitar. */
export function job(overrides: Partial<EligibilityJob> = {}): EligibilityJob {
  return {
    title: 'Estágio em Desenvolvimento de Software',
    company: 'Empresa Exemplo',
    location: 'São Paulo - Pinheiros',
    workMode: 'hibrido',
    description: null,
    stipendMin: 1500,
    stipendMax: 1500,
    stipendCurrency: 'BRL',
    ...overrides,
  };
}

export const NOW = new Date('2026-10-22T12:00:00Z');

export function find(
  criteria: readonly Criterion[],
  id: CriterionId,
  kind: Criterion['kind'] = 'obrigatorio',
): Criterion | undefined {
  return criteria.find((criterion) => criterion.id === id && criterion.kind === kind);
}
