import { suggestVariant } from '../cli/cv-attach.js';
import type { Db } from '../db/index.js';
import { classifyJobAreas, type Criterion, type JobArea } from '../eligibility/index.js';
import { resolveConnector } from './connectors.js';
import type { Policy } from './policy.js';

/**
 * Decisão da política sobre UMA vaga. Função de leitura: não grava nada e não envia nada.
 *   candidatar      dentro da política e com canal disponível;
 *   pendente_canal  dentro da política, mas sem canal automático permitido (você candidata manualmente);
 *   pendente        falta informação comprovada (requisito, local, área...) ou exige revisão humana;
 *   descartada      fora da política ou comprovadamente incompatível.
 * Vaga com requisito desejável que você não domina NÃO é descartada: só requisito obrigatório comprovadamente
 * não atendido (já avaliado na elegibilidade) descarta.
 */
export type DecisionKind = 'candidatar' | 'pendente' | 'pendente_canal' | 'descartada';

export interface Decision {
  kind: DecisionKind;
  reasons: string[];
  connector?: string;
  cvVariant?: string;
  /** automatico = o agente conclui; assistido = exige você. Só existe quando a vaga passou pela política. */
  flow?: 'automatico' | 'assistido';
  /** Barreiras do canal e avisos (ex.: modalidade desconhecida) para quem for executar a candidatura. */
  warnings?: string[];
}

export interface JobFacts {
  id: number;
  title: string;
  company: string | null;
  workMode: 'remoto' | 'hibrido' | 'presencial' | null;
  stipend: number | null;
  description: string | null;
  url: string;
  applyUrl: string | null;
  sourceKind: string;
  verdict: 'apto' | 'inapto' | 'revisao_humana';
  criteria: readonly Criterion[];
}

const norm = (value: string): string => value.trim().toLowerCase();
const inList = (list: readonly string[], value: string | null): boolean =>
  value !== null && list.some((item) => norm(item) === norm(value));

export function decideJob(db: Db, policy: Policy, job: JobFacts): Decision {
  const { rules } = policy;
  const discard = (reason: string): Decision => ({ kind: 'descartada', reasons: [reason] });

  if (job.verdict === 'inapto') return discard('inapta pela elegibilidade do perfil');
  if (inList(rules.companiesDeny, job.company)) return discard('empresa na lista de exclusão');
  if (rules.companiesAllow.length > 0 && !inList(rules.companiesAllow, job.company))
    return discard('empresa fora da lista permitida');
  if (rules.sourcesAllow.length > 0 && !inList(rules.sourcesAllow, job.sourceKind))
    return discard(`fonte "${job.sourceKind}" fora da lista permitida`);
  if (job.workMode !== null && !rules.workModes.includes(job.workMode))
    return discard(`modalidade "${job.workMode}" fora da política`);
  // Bolsa divulgada abaixo do mínimo descarta; bolsa desconhecida nunca descarta.
  if (job.stipend !== null && job.stipend < rules.minStipend)
    return discard(`bolsa divulgada (${job.stipend}) abaixo do mínimo (${rules.minStipend})`);
  const commute = job.criteria.find((c) => c.id === 'deslocamento');
  if (commute?.outcome === 'nao_atende')
    return discard('deslocamento comprovadamente incompatível');

  if (rules.areas.length > 0) {
    const classified = classifyJobAreas(job.title, job.description);
    const found: JobArea[] =
      classified.fromTitle.length > 0 ? classified.fromTitle : classified.fromDescription;
    const wanted = new Set(rules.areas.map(norm));
    if (found.length === 0)
      return {
        kind: 'pendente',
        reasons: ['área da vaga não identificada para aplicar o filtro de áreas'],
      };
    if (!found.some((area) => wanted.has(area)))
      return discard(`área (${found.join(', ')}) fora da política`);
  }

  // Critério desconhecido (nunca reprovado) pode ser tolerado por opção sua; comprovadamente reprovado nunca.
  let verdict = job.verdict;
  const unresolved = job.criteria.filter(
    (c) => c.kind === 'obrigatorio' && c.outcome === 'indeterminado',
  );
  if (
    verdict === 'revisao_humana' &&
    unresolved.length > 0 &&
    unresolved.every((c) => (rules.tolerateUnknown as readonly string[]).includes(c.id))
  )
    verdict = 'apto';

  if (!rules.verdicts.includes(verdict)) {
    // Só o que de fato bloqueia: o que a política tolera (bolsa desconhecida) não entra na lista.
    const open = job.criteria
      .filter(
        (c) =>
          c.kind === 'obrigatorio' &&
          c.outcome === 'indeterminado' &&
          !(rules.tolerateUnknown as readonly string[]).includes(c.id),
      )
      .map((c) => c.detail);
    return {
      kind: 'pendente',
      reasons: [
        'exige revisão humana: há informação obrigatória sem comprovação (nada é presumido)',
        ...open.slice(0, 3),
      ],
    };
  }

  const resolved = resolveConnector(db, job);
  const cvVariant = suggestVariant(job.title, job.description).variant;
  const warnings = [...resolved.connector.barriers.map((b) => `barreira do canal: ${b}`)];
  if (job.workMode === null)
    warnings.push(
      'modalidade desconhecida (não é presumida remota nem híbrida): se o formulário pedir disponibilidade presencial, confirme com você',
    );
  if (job.stipend === null) warnings.push('bolsa não divulgada (tolerada pela política)');
  if (!resolved.available)
    return {
      kind: 'pendente_canal',
      reasons: [resolved.reason],
      connector: resolved.connector.id,
      cvVariant,
      flow: resolved.connector.flow,
      warnings,
    };
  return {
    kind: 'candidatar',
    reasons: ['dentro da política e com canal disponível'],
    connector: resolved.connector.id,
    cvVariant,
    flow: resolved.connector.flow,
    warnings,
  };
}
