import type { WorkMode } from '../discovery/work-mode.js';

export const VERDICTS = ['apto', 'inapto', 'revisao_humana'] as const;
export type Verdict = (typeof VERDICTS)[number];

/** `indeterminado` = faltou dado no perfil ou na vaga; nunca é resolvido por suposição. */
export type Outcome = 'atende' | 'nao_atende' | 'indeterminado';

/** Obrigatório decide o veredito; diferencial só informa (e serve para ordenar vagas). */
export type CriterionKind = 'obrigatorio' | 'diferencial';

export type CriterionId =
  | 'perfil'
  | 'area'
  | 'bolsa'
  | 'modalidade'
  | 'localizacao'
  | 'deslocamento'
  | 'idioma'
  | 'curso'
  | 'semestre'
  | 'formatura'
  | 'carga-horaria'
  | 'inicio'
  | 'tecnologia';

export interface Criterion {
  id: CriterionId;
  kind: CriterionKind;
  outcome: Outcome;
  /** Explicação em português do que foi comparado. */
  detail: string;
  /** Trecho da vaga que originou o critério, quando há. */
  evidence?: string;
}

export interface EligibilityResult {
  verdict: Verdict;
  /** Motivos que decidiram o veredito, em frases curtas. */
  reasons: string[];
  criteria: Criterion[];
  differentials: { matched: number; total: number };
}

/** Os campos da vaga de que a análise precisa (compatível com a linha de `jobs`). */
export interface EligibilityJob {
  title: string;
  company?: string | null | undefined;
  location?: string | null | undefined;
  workMode: WorkMode | null;
  description?: string | null | undefined;
  stipendMin: number | null;
  stipendMax: number | null;
  stipendCurrency: string | null;
  stipendText?: string | null | undefined;
}

export interface EvaluateOptions {
  /** Relógio injetável (datas de início). */
  now?: Date;
}
