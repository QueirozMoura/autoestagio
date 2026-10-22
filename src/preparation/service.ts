import {
  annotateApplication,
  createApplication,
  getApplication,
  setApplicationChannel,
  type Application,
  type Channel,
} from '../applications/index.js';
import type { CvReference, Profile } from '../config/index.js';
import type { Db } from '../db/index.js';
import { analyzeJobs, profileHash as hashProfile, type Criterion } from '../eligibility/index.js';
import { technologiesIn } from '../eligibility/requirements.js';
import {
  GENERATOR_VERSION,
  cleanInline,
  contentHash,
  generateDraft,
  type Fact,
  type GeneratedDraft,
} from './message.js';
import {
  answerQuestion,
  detectRequirements,
  type RequirementKind,
  type RequirementSpec,
} from './requirements.js';

export class PreparationError extends Error {
  constructor(
    readonly code: 'mensagem_insegura' | 'nao_encontrada' | 'guarda' | 'entrada_invalida',
    message: string,
  ) {
    super(message);
    this.name = 'PreparationError';
  }
}

export type Readiness =
  'sem_rascunho' | 'desatualizada' | 'incompleta' | 'pronta_para_revisao' | 'revisada';

export const READINESS_LABELS: Record<Readiness, string> = {
  sem_rascunho: 'sem rascunho',
  desatualizada: 'desatualizada (entradas mudaram; regenere)',
  incompleta: 'incompleta (há pendências bloqueantes)',
  pronta_para_revisao: 'pronta para revisão',
  revisada: 'revisada por você',
};

interface DraftRow {
  application_id: number;
  subject: string;
  body: string;
  facts: string;
  generator_version: string;
  profile_hash: string;
  job_content_hash: string;
  cv_sha256: string;
  content_hash: string;
  generated_at: string;
  reviewed_hash: string | null;
  reviewed_at: string | null;
}

interface JobRow {
  id: number;
  title: string;
  company: string | null;
  description: string | null;
  content_hash: string;
}

const MAX_ANSWER = 1000;

// ------------------------------------------------------------------ segurança da mensagem

/**
 * Última barreira antes de gravar: a mensagem não pode ter e-mails, links nem telefones, e
 * qualquer tecnologia citada como habilidade precisa estar no perfil aprovado.
 */
export function assertDraftSafe(
  draft: GeneratedDraft,
  profile: Profile,
  job: { title: string; company: string | null },
): void {
  const text = `${draft.subject}\n${draft.body}`;
  if (/@|https?:\/\/|www\./i.test(text)) {
    throw new PreparationError('mensagem_insegura', 'a mensagem contém e-mail ou link');
  }
  if (/\(?\d{2}\)?[\s.-]?9?\d{4}[\s.-]?\d{4}/.test(text)) {
    throw new PreparationError('mensagem_insegura', 'a mensagem contém algo parecido com telefone');
  }
  for (const fact of draft.facts) {
    if (!fact.source.startsWith('perfil.') && !fact.source.startsWith('vaga.')) {
      throw new PreparationError('mensagem_insegura', `afirmação sem origem válida: ${fact.claim}`);
    }
  }
  // Título e empresa são da vaga (podem citar tecnologias); o resto precisa estar no perfil.
  let claims = draft.body;
  for (const part of [
    cleanInline(job.title),
    job.company === null ? '' : cleanInline(job.company, 80),
  ]) {
    if (part !== '') claims = claims.split(part).join('');
  }
  const have = new Set<string>();
  for (const technology of profile.technologies) {
    for (const name of technologiesIn(technology)) have.add(name);
  }
  const foreign = [...technologiesIn(claims)].filter((name) => !have.has(name));
  if (foreign.length > 0) {
    throw new PreparationError(
      'mensagem_insegura',
      `tecnologia fora do perfil aprovado: ${foreign.join(', ')}`,
    );
  }
}

// ------------------------------------------------------------------ persistência interna

function loadJob(db: Db, jobId: number): JobRow | undefined {
  return db
    .prepare('SELECT id, title, company, description, content_hash FROM jobs WHERE id = ?')
    .get(jobId) as JobRow | undefined;
}

function loadDraft(db: Db, applicationId: number): DraftRow | undefined {
  return db
    .prepare('SELECT * FROM application_drafts WHERE application_id = ?')
    .get(applicationId) as DraftRow | undefined;
}

function syncRequirements(
  db: Db,
  applicationId: number,
  specs: readonly RequirementSpec[],
  now: string,
): void {
  const insert = db.prepare(
    `INSERT OR IGNORE INTO application_requirements (application_id, key, label, kind, blocking, created_at)
     VALUES (@applicationId, @key, @label, @kind, @blocking, @now)`,
  );
  for (const spec of specs) {
    insert.run({
      applicationId,
      key: spec.key,
      label: spec.label,
      kind: spec.kind,
      blocking: spec.blocking ? 1 : 0,
      now,
    });
  }
  // Pendências que deixaram de valer e nunca foram respondidas saem; respondidas e perguntas ficam.
  const keep = new Set(specs.map((spec) => spec.key));
  const rows = db
    .prepare(
      "SELECT key FROM application_requirements WHERE application_id = ? AND answer IS NULL AND kind <> 'pergunta'",
    )
    .all(applicationId) as { key: string }[];
  const drop = db.prepare(
    'DELETE FROM application_requirements WHERE application_id = ? AND key = ?',
  );
  for (const { key } of rows) if (!keep.has(key)) drop.run(applicationId, key);
}

function pendingBlocking(db: Db, applicationId: number): number {
  return (
    db
      .prepare(
        'SELECT COUNT(*) AS n FROM application_requirements WHERE application_id = ? AND blocking = 1 AND answer IS NULL',
      )
      .get(applicationId) as { n: number }
  ).n;
}

function isStale(
  draft: DraftRow,
  job: JobRow | undefined,
  profileHash: string | undefined,
): boolean {
  if (draft.generator_version !== GENERATOR_VERSION) return true;
  if (job !== undefined && draft.job_content_hash !== job.content_hash) return true;
  return profileHash !== undefined && draft.profile_hash !== profileHash;
}

export function computeReadiness(db: Db, applicationId: number, profileHash?: string): Readiness {
  const draft = loadDraft(db, applicationId);
  if (draft === undefined) return 'sem_rascunho';
  const application = getApplication(db, applicationId);
  const job = application === undefined ? undefined : loadJob(db, application.jobId);
  if (isStale(draft, job, profileHash)) return 'desatualizada';
  if (pendingBlocking(db, applicationId) > 0) return 'incompleta';
  return draft.reviewed_hash === draft.content_hash ? 'revisada' : 'pronta_para_revisao';
}

function writeDraft(
  db: Db,
  application: Application,
  job: JobRow,
  profile: Profile,
  profileHash: string,
  now: Date,
  action: 'gerado' | 'regenerado',
): void {
  const eligibility = db
    .prepare('SELECT verdict, criteria FROM job_eligibility WHERE job_id = ?')
    .get(job.id) as { verdict: 'apto' | 'revisao_humana' | 'inapto'; criteria: string } | undefined;
  if (eligibility === undefined || eligibility.verdict === 'inapto') {
    throw new PreparationError('guarda', 'vaga sem análise válida ou inapta');
  }

  const draft = generateDraft({
    profile,
    job: { title: job.title, company: job.company, description: job.description },
    cvLabel: application.cvLabel,
    now,
  });
  assertDraftSafe(draft, profile, job);

  const at = now.toISOString();
  db.prepare(
    `INSERT INTO application_drafts (
       application_id, subject, body, language, facts, generator_version, profile_hash,
       job_content_hash, cv_sha256, content_hash, generated_at, reviewed_hash, reviewed_at
     ) VALUES (@id, @subject, @body, @language, @facts, @version, @profileHash, @jobHash, @cv, @hash, @at, NULL, NULL)
     ON CONFLICT (application_id) DO UPDATE SET
       subject = excluded.subject, body = excluded.body, language = excluded.language,
       facts = excluded.facts, generator_version = excluded.generator_version,
       profile_hash = excluded.profile_hash, job_content_hash = excluded.job_content_hash,
       cv_sha256 = excluded.cv_sha256, content_hash = excluded.content_hash,
       generated_at = excluded.generated_at, reviewed_hash = NULL, reviewed_at = NULL`,
  ).run({
    id: application.id,
    subject: draft.subject,
    body: draft.body,
    language: draft.language,
    facts: JSON.stringify(draft.facts),
    version: GENERATOR_VERSION,
    profileHash,
    jobHash: job.content_hash,
    cv: application.cvSha256,
    hash: contentHash(draft, {
      profileHash,
      jobContentHash: job.content_hash,
      cvSha256: application.cvSha256,
    }),
    at,
  });

  syncRequirements(
    db,
    application.id,
    detectRequirements({
      description: job.description,
      channel: getApplication(db, application.id)?.channel ?? null,
      verdict: eligibility.verdict,
      eligibility: JSON.parse(eligibility.criteria) as Criterion[],
    }),
    at,
  );
  annotateApplication(
    db,
    application.id,
    {
      reason: `rascunho ${action} (gerador v${GENERATOR_VERSION}); nada foi enviado`,
      actor: 'sistema',
    },
    now,
  );
}

// ------------------------------------------------------------------ preparar

export interface PrepareOptions {
  profile: Profile;
  /** Já conferida contra o PDF (`verifyApprovedCv`). */
  cv: CvReference;
  jobId: number;
  channel?: Channel;
  /** Decisão explícita do usuário, para esta vaga, de preparar uma vaga em revisão humana. */
  reviewOverride?: { reason: string };
  acknowledgeEquivalent?: { reason: string };
  /** Refaz um rascunho desatualizado (só enquanto a candidatura está "preparada"). */
  regenerate?: boolean;
  now?: Date;
}

export type PrepareResult =
  | {
      outcome: 'preparada' | 'regenerada' | 'inalterada' | 'desatualizada';
      applicationId: number;
      readiness: Readiness;
      warnings: number;
    }
  | { outcome: 'recusada'; reason: string; detail: string };

/**
 * Prepara a candidatura de uma vaga: cria (dry-run) a candidatura, gera o rascunho e levanta o que
 * falta. Atômico e idempotente: repetir não duplica; duas chamadas simultâneas resultam em um rascunho.
 * Nunca envia nada.
 */
export function prepareApplication(db: Db, options: PrepareOptions): PrepareResult {
  const { profile, cv, jobId } = options;
  const now = options.now ?? new Date();
  if (profile.approval === undefined) {
    return {
      outcome: 'recusada',
      reason: 'perfil_nao_aprovado',
      detail: 'o perfil ainda não foi aprovado',
    };
  }
  if (profile.approval.cvSha256 !== cv.sha256) {
    return {
      outcome: 'recusada',
      reason: 'curriculo_divergente',
      detail: 'o currículo informado não é o aprovado no perfil (SHA-256 diferente)',
    };
  }
  const profileHash = hashProfile(profile);

  const run = db.transaction((): PrepareResult => {
    const job = loadJob(db, jobId);
    if (job === undefined) {
      return {
        outcome: 'recusada',
        reason: 'vaga_inexistente',
        detail: `vaga ${jobId} não existe`,
      };
    }
    // A elegibilidade precisa refletir o perfil de agora.
    analyzeJobs({ db, profile, jobIds: [jobId], now });

    const created = createApplication(
      db,
      {
        jobId,
        cv,
        profileHash,
        ...(options.channel === undefined ? {} : { channel: options.channel }),
        ...(options.reviewOverride === undefined ? {} : { reviewOverride: options.reviewOverride }),
        ...(options.acknowledgeEquivalent === undefined
          ? {}
          : { acknowledgeEquivalent: options.acknowledgeEquivalent }),
      },
      now,
    );
    if (!created.created && created.reason !== 'ja_existe') {
      return { outcome: 'recusada', reason: created.reason, detail: created.detail };
    }
    const application = created.application;
    const warnings = created.created ? created.warnings.length : 0;

    if (application.cvSha256 !== cv.sha256) {
      return {
        outcome: 'recusada',
        reason: 'curriculo_alterado',
        detail:
          'a candidatura foi criada com outra versão do currículo, que não muda depois de criada',
      };
    }

    let current = application;
    if (
      !created.created &&
      options.channel !== undefined &&
      application.channel !== options.channel &&
      application.status === 'preparada'
    ) {
      current = setApplicationChannel(
        db,
        application.id,
        options.channel,
        {
          reason: 'definido ao preparar',
          actor: 'usuario',
        },
        now,
      );
    }

    const draft = loadDraft(db, current.id);
    if (draft === undefined) {
      writeDraft(db, current, job, profile, profileHash, now, 'gerado');
      return {
        outcome: 'preparada',
        applicationId: current.id,
        readiness: computeReadiness(db, current.id, profileHash),
        warnings,
      };
    }
    if (isStale(draft, job, profileHash)) {
      if (options.regenerate === true && current.status === 'preparada') {
        writeDraft(db, current, job, profile, profileHash, now, 'regenerado');
        return {
          outcome: 'regenerada',
          applicationId: current.id,
          readiness: computeReadiness(db, current.id, profileHash),
          warnings,
        };
      }
      return {
        outcome: 'desatualizada',
        applicationId: current.id,
        readiness: 'desatualizada',
        warnings,
      };
    }
    return {
      outcome: 'inalterada',
      applicationId: current.id,
      readiness: computeReadiness(db, current.id, profileHash),
      warnings,
    };
  });
  return run.immediate();
}

/** Conteúdo exato do rascunho, para o canal de envio (só leitura). */
export function getDraftRecord(
  db: Db,
  applicationId: number,
): { subject: string; body: string; contentHash: string; reviewedHash: string | null } | undefined {
  const draft = loadDraft(db, applicationId);
  return draft === undefined
    ? undefined
    : {
        subject: draft.subject,
        body: draft.body,
        contentHash: draft.content_hash,
        reviewedHash: draft.reviewed_hash,
      };
}

// ------------------------------------------------------------------ revisar

export interface RequirementView {
  key: string;
  label: string;
  kind: RequirementKind;
  blocking: boolean;
  answered: boolean;
  answeredBy: 'perfil' | 'usuario' | null;
  /** Só preenchido quando o chamador pede explicitamente. */
  answer?: string;
}

export interface PreparationView {
  application: Application;
  jobTitle: string;
  company: string | null;
  readiness: Readiness;
  draft: {
    subject: string;
    body: string;
    facts: Fact[];
    generatedAt: string;
    reviewedAt: string | null;
  } | null;
  requirements: RequirementView[];
}

export function getPreparation(
  db: Db,
  applicationId: number,
  options: { profileHash?: string; showAnswers?: boolean } = {},
): PreparationView | undefined {
  const application = getApplication(db, applicationId);
  if (application === undefined) return undefined;
  const job = loadJob(db, application.jobId);
  const draft = loadDraft(db, applicationId);
  const rows = db
    .prepare(
      'SELECT * FROM application_requirements WHERE application_id = ? ORDER BY blocking DESC, id',
    )
    .all(applicationId) as {
    key: string;
    label: string;
    kind: RequirementKind;
    blocking: number;
    answer: string | null;
    answered_by: 'perfil' | 'usuario' | null;
  }[];
  return {
    application,
    jobTitle: job?.title ?? '?',
    company: job?.company ?? null,
    readiness: computeReadiness(db, applicationId, options.profileHash),
    draft:
      draft === undefined
        ? null
        : {
            subject: draft.subject,
            body: draft.body,
            facts: JSON.parse(draft.facts) as Fact[],
            generatedAt: draft.generated_at,
            reviewedAt: draft.reviewed_at,
          },
    requirements: rows.map((row) => ({
      key: row.key,
      label: row.label,
      kind: row.kind,
      blocking: row.blocking === 1,
      answered: row.answer !== null,
      answeredBy: row.answered_by,
      ...(options.showAnswers === true && row.answer !== null ? { answer: row.answer } : {}),
    })),
  };
}

function requirePreparada(db: Db, applicationId: number): Application {
  const application = getApplication(db, applicationId);
  if (application === undefined) {
    throw new PreparationError('nao_encontrada', `candidatura ${applicationId} não existe`);
  }
  if (application.status !== 'preparada') {
    throw new PreparationError(
      'guarda',
      'só é possível alterar o preparo enquanto a candidatura está "preparada"',
    );
  }
  return application;
}

/** Uma pessoa responde uma pendência (a única fonte de resposta além do perfil aprovado). */
export function answerRequirement(
  db: Db,
  applicationId: number,
  key: string,
  text: string,
  now: Date = new Date(),
): void {
  const answer = text.trim().slice(0, MAX_ANSWER);
  if (answer === '')
    throw new PreparationError('entrada_invalida', 'a resposta não pode ser vazia');
  const run = db.transaction(() => {
    requirePreparada(db, applicationId);
    const changed = db
      .prepare(
        `UPDATE application_requirements SET answer = ?, answered_by = 'usuario', answered_at = ?
          WHERE application_id = ? AND key = ?`,
      )
      .run(answer, now.toISOString(), applicationId, key).changes;
    if (changed !== 1)
      throw new PreparationError('nao_encontrada', `pendência "${key}" não existe`);
    annotateApplication(
      db,
      applicationId,
      { reason: `pendência respondida pelo usuário: ${key}`, actor: 'usuario' },
      now,
    );
  });
  run.immediate();
}

/**
 * Registra uma pergunta vista em um formulário. Se é uma das poucas que o perfil aprovado responde
 * (nome, curso, semestre...), responde com o perfil; qualquer outra fica PENDENTE, sem resposta.
 */
export function addQuestion(
  db: Db,
  applicationId: number,
  profile: Profile,
  question: string,
  now: Date = new Date(),
): { key: string; answered: boolean; answeredBy: 'perfil' | null } {
  if (question.trim() === '')
    throw new PreparationError('entrada_invalida', 'a pergunta não pode ser vazia');
  const result = answerQuestion(profile, question);
  const run = db.transaction(() => {
    requirePreparada(db, applicationId);
    const inserted = db
      .prepare(
        `INSERT OR IGNORE INTO application_requirements
           (application_id, key, label, kind, blocking, answer, answered_by, answered_at, created_at)
         VALUES (@applicationId, @key, @label, 'pergunta', 1, @answer, @by, @at, @now)`,
      )
      .run({
        applicationId,
        key: result.key,
        label: result.label,
        answer: result.answer ?? null,
        by: result.answer === undefined ? null : 'perfil',
        at: result.answer === undefined ? null : now.toISOString(),
        now: now.toISOString(),
      }).changes;
    if (inserted === 1) {
      annotateApplication(
        db,
        applicationId,
        {
          reason: `pergunta de formulário registrada (${result.answer === undefined ? 'pendente' : 'respondida pelo perfil'}): ${result.key}`,
          actor: 'sistema',
        },
        now,
      );
    }
  });
  run.immediate();
  const row = db
    .prepare(
      'SELECT answer, answered_by FROM application_requirements WHERE application_id = ? AND key = ?',
    )
    .get(applicationId, result.key) as {
    answer: string | null;
    answered_by: 'perfil' | 'usuario' | null;
  };
  return {
    key: result.key,
    answered: row.answer !== null,
    answeredBy: row.answered_by === 'perfil' ? 'perfil' : null,
  };
}

/** O usuário confirma que revisou ESTE conteúdo. Qualquer mudança depois invalida a revisão. */
export function markReviewed(
  db: Db,
  applicationId: number,
  profileHash: string,
  now: Date = new Date(),
): void {
  const run = db.transaction(() => {
    requirePreparada(db, applicationId);
    const readiness = computeReadiness(db, applicationId, profileHash);
    if (readiness === 'revisada') return;
    if (readiness !== 'pronta_para_revisao') {
      throw new PreparationError(
        'guarda',
        `não dá para marcar como revisada: ${READINESS_LABELS[readiness]}`,
      );
    }
    db.prepare(
      'UPDATE application_drafts SET reviewed_hash = content_hash, reviewed_at = ? WHERE application_id = ?',
    ).run(now.toISOString(), applicationId);
    annotateApplication(
      db,
      applicationId,
      { reason: 'rascunho revisado pelo usuário; ainda não aprovado para envio', actor: 'usuario' },
      now,
    );
  });
  run.immediate();
}

// ------------------------------------------------------------------ candidatas

export interface Candidate {
  jobId: number;
  title: string;
  company: string | null;
  verdict: 'apto' | 'revisao_humana';
}

/** Vagas com análise atual, aptas ou em revisão, que ainda não têm candidatura. */
export function listCandidates(db: Db, profileHash: string): Candidate[] {
  const rows = db
    .prepare(
      `SELECT j.id AS job_id, j.title, j.company, e.verdict
         FROM job_eligibility e JOIN jobs j ON j.id = e.job_id
        WHERE e.verdict IN ('apto', 'revisao_humana') AND e.profile_hash = ?
          AND NOT EXISTS (SELECT 1 FROM applications a WHERE a.job_id = j.id)
        ORDER BY e.verdict, j.id`,
    )
    .all(profileHash) as {
    job_id: number;
    title: string;
    company: string | null;
    verdict: Candidate['verdict'];
  }[];
  return rows.map((row) => ({
    jobId: row.job_id,
    title: row.title,
    company: row.company,
    verdict: row.verdict,
  }));
}
