import type { Db } from '../db/index.js';
import { SENT_STATES, type Status } from './states.js';

export type EquivalenceKind =
  /** Mesma URL (canônica, de candidatura ou de outra aparição): é a mesma vaga. (Mesmo id na mesma fonte já vira a mesma vaga na coleta: índice único em job_sightings.) */
  | 'mesma_url'
  /** Empresa + título + local iguais: indício forte, mas não prova. */
  | 'identidade'
  /** A coleta já marcou o par como "possível duplicata". */
  | 'possivel_duplicata';

export interface Equivalent {
  applicationId: number;
  jobId: number;
  status: Status;
  kind: EquivalenceKind;
}

export interface EquivalenceReport {
  /** Candidaturas ativas em vagas equivalentes: bloqueiam a criação. */
  blocking: Equivalent[];
  /** Outras candidaturas à mesma empresa: só aviso. */
  sameCompany: { applicationId: number; jobId: number; status: Status }[];
}

/** Kinds que uma pessoa pode liberar conscientemente; os demais nunca. */
export const OVERRIDABLE: ReadonlySet<EquivalenceKind> = new Set<EquivalenceKind>([
  'identidade',
  'possivel_duplicata',
]);

interface Row {
  application_id: number;
  job_id: number;
  status: Status;
  kind: EquivalenceKind;
}

/**
 * Procura candidaturas em vagas que podem ser a mesma que `jobId`. É conservador de propósito:
 * errar para o lado de bloquear custa uma revisão; errar para o outro lado custa um envio duplicado.
 * Candidaturas que falharam sem nunca terem saído não contam (não houve envio).
 */
export function findEquivalent(db: Db, jobId: number): EquivalenceReport {
  const active = `a.job_id <> @jobId AND NOT (a.status = 'falhou' AND NOT EXISTS (
      SELECT 1 FROM application_events e
       WHERE e.application_id = a.id AND e.to_status IN ('enviando', 'enviada')))`;

  const rows = db
    .prepare(
      `SELECT a.id AS application_id, a.job_id, a.status, 'mesma_url' AS kind
         FROM applications a JOIN jobs j2 ON j2.id = a.job_id, jobs j
        WHERE j.id = @jobId AND ${active} AND (
              j2.canonical_url = j.canonical_url
           OR (j.apply_url IS NOT NULL AND j2.apply_url = j.apply_url)
           OR EXISTS (SELECT 1 FROM job_sightings s1 JOIN job_sightings s2
                        ON s2.canonical_url = s1.canonical_url
                       WHERE s1.job_id = j.id AND s2.job_id = j2.id))
       UNION
       SELECT a.id, a.job_id, a.status, 'identidade'
         FROM applications a JOIN jobs j2 ON j2.id = a.job_id, jobs j
        WHERE j.id = @jobId AND ${active}
          AND j.identity_key IS NOT NULL AND j2.identity_key = j.identity_key
       UNION
       SELECT a.id, a.job_id, a.status, 'possivel_duplicata'
         FROM applications a
        WHERE ${active} AND EXISTS (
              SELECT 1 FROM job_possible_duplicates d
               WHERE (d.job_id = @jobId AND d.other_job_id = a.job_id)
                  OR (d.other_job_id = @jobId AND d.job_id = a.job_id))`,
    )
    .all({ jobId }) as Row[];

  const blocking = rows.map((row) => ({
    applicationId: row.application_id,
    jobId: row.job_id,
    status: row.status,
    kind: row.kind,
  }));

  const sameCompany = (
    db
      .prepare(
        `SELECT a.id AS application_id, a.job_id, a.status
           FROM applications a JOIN jobs j2 ON j2.id = a.job_id, jobs j
          WHERE j.id = @jobId AND a.job_id <> @jobId AND j.company IS NOT NULL
            AND lower(trim(j2.company)) = lower(trim(j.company))`,
      )
      .all({ jobId }) as Omit<Row, 'kind'>[]
  ).map((row) => ({ applicationId: row.application_id, jobId: row.job_id, status: row.status }));

  return { blocking, sameCompany };
}

/** Alguma candidatura equivalente já saiu (ou pode ter saído)? Usado de novo antes de enviar. */
export function alreadySentEquivalent(report: EquivalenceReport): Equivalent | undefined {
  return report.blocking.find((item) => SENT_STATES.has(item.status));
}
