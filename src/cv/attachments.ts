import type { Db } from '../db/index.js';
import { annotateApplication, getApplication } from '../applications/index.js';
import { ARTIFACT_VALIDATION, type AttachmentState } from './artifacts.js';

/**
 * Operações sobre o registro de artefatos e o vínculo candidatura↔currículo (migração 0008).
 * Cada estado tem significado próprio: registrar um artefato NÃO vincula; vincular NÃO aprova;
 * aprovar o vínculo NÃO aprova o envio nem envia nada; revogar encerra o vínculo para sempre.
 * Um registro aqui nunca prova que o PDF continua íntegro: quem usa precisa reverificá-lo.
 */

const MESSAGES = {
  APPLICATION_NOT_FOUND: 'Candidatura inexistente.',
  JOB_NOT_FOUND: 'Vaga da candidatura inexistente.',
  JOB_MISMATCH: 'A candidatura não pertence à vaga informada.',
  APPLICATION_NOT_PREPARED:
    'A candidatura precisa estar no estado "preparada" para receber um vínculo.',
  ARTIFACT_HASH_DIVERGENT:
    'Já existe um artefato registrado para esta variante e este modelo com outro hash de PDF. Nada foi alterado.',
  LIVE_LINK_EXISTS:
    'A candidatura já tem um vínculo de currículo vivo. Revogue-o (se aprovado) ou use --replace (se em preparação).',
  NO_PREPARING_LINK: 'A candidatura não tem vínculo de currículo em preparação.',
  NO_APPROVED_LINK: 'A candidatura não tem vínculo de currículo aprovado.',
  CONFIRMATION_MISMATCH: 'A confirmação (--sha8) não corresponde ao artefato vinculado.',
  REASON_REQUIRED: 'Informe o motivo (1 a 300 caracteres).',
  STATE_NOT_ALLOWED: 'Operação não permitida no estado atual da candidatura ou do vínculo.',
} as const;
export type AttachmentErrorCode = keyof typeof MESSAGES;

/** Mensagem fixa em português: sem caminhos, hashes completos nem texto de currículo. */
export class AttachmentError extends Error {
  constructor(readonly code: AttachmentErrorCode) {
    super(MESSAGES[code]);
    this.name = 'AttachmentError';
  }
}

export interface NewArtifact {
  variant: string;
  pdfSha256: string;
  pdfBytes: number;
  pages: number;
  modelHash: string;
  generatedAt: Date;
  fileName: string;
}

/**
 * Registra o artefato. Mesmo (variante, modelo) com o MESMO hash reaproveita o registro; com OUTRO
 * hash bloqueia: o hash registrado nunca é atualizado e nenhum outro artefato é escolhido em silêncio.
 */
export function registerArtifact(db: Db, artifact: NewArtifact): { id: number; created: boolean } {
  return db
    .transaction((): { id: number; created: boolean } => {
      const same = db
        .prepare('SELECT id, pdf_sha256 FROM cv_artifacts WHERE variant = ? AND model_hash = ?')
        .all(artifact.variant, artifact.modelHash) as { id: number; pdf_sha256: string }[];
      const match = same.find((row) => row.pdf_sha256 === artifact.pdfSha256);
      if (match !== undefined) return { id: match.id, created: false };
      if (same.length > 0) throw new AttachmentError('ARTIFACT_HASH_DIVERGENT');
      const result = db
        .prepare(
          `INSERT INTO cv_artifacts (variant, pdf_sha256, pdf_bytes, pages, model_hash, generated_at, validation, file_name)
           VALUES (@variant, @sha, @bytes, @pages, @model, @at, @validation, @file)`,
        )
        .run({
          variant: artifact.variant,
          sha: artifact.pdfSha256,
          bytes: artifact.pdfBytes,
          pages: artifact.pages,
          model: artifact.modelHash,
          at: artifact.generatedAt.toISOString(),
          validation: ARTIFACT_VALIDATION,
          file: artifact.fileName,
        });
      return { id: Number(result.lastInsertRowid), created: true };
    })
    .immediate();
}

export interface AttachmentView {
  id: number;
  applicationId: number;
  jobId: number;
  artifactId: number;
  variant: string;
  state: AttachmentState;
  createdAt: string;
  approvedAt: string | null;
  revokedAt: string | null;
  supersededAt: string | null;
  pages: number;
  /** Só os 8 primeiros hex: suficiente para conferir, sem expor o hash completo. */
  pdfSha8: string;
  modelHash8: string;
}

interface Joined {
  id: number;
  application_id: number;
  job_id: number;
  artifact_id: number;
  variant: string;
  state: AttachmentState;
  created_at: string;
  approved_at: string | null;
  revoked_at: string | null;
  superseded_at: string | null;
  pages: number;
  pdf_sha256: string;
  model_hash: string;
}
const toView = (row: Joined): AttachmentView => ({
  id: row.id,
  applicationId: row.application_id,
  jobId: row.job_id,
  artifactId: row.artifact_id,
  variant: row.variant,
  state: row.state,
  createdAt: row.created_at,
  approvedAt: row.approved_at,
  revokedAt: row.revoked_at,
  supersededAt: row.superseded_at,
  pages: row.pages,
  pdfSha8: row.pdf_sha256.slice(0, 8),
  modelHash8: row.model_hash.slice(0, 8),
});
const SELECT = `SELECT l.*, a.pages, a.pdf_sha256, a.model_hash
                  FROM application_cv_attachments l JOIN cv_artifacts a ON a.id = l.artifact_id`;

/** Histórico completo (do mais antigo ao mais recente). */
export function listAttachments(db: Db, applicationId: number): AttachmentView[] {
  return (
    db.prepare(`${SELECT} WHERE l.application_id = ? ORDER BY l.id`).all(applicationId) as Joined[]
  ).map(toView);
}

/** Hash completo do PDF do vínculo vivo, para reverificação (uso interno; não é exibido). */
export function liveAttachment(
  db: Db,
  applicationId: number,
): (AttachmentView & { pdfSha256: string; modelHash: string }) | undefined {
  const row = db
    .prepare(`${SELECT} WHERE l.application_id = ? AND l.state IN ('em_preparacao', 'aprovado')`)
    .get(applicationId) as Joined | undefined;
  return row === undefined
    ? undefined
    : { ...toView(row), pdfSha256: row.pdf_sha256, modelHash: row.model_hash };
}

function requireApplication(db: Db, applicationId: number) {
  const application = getApplication(db, applicationId);
  if (application === undefined) throw new AttachmentError('APPLICATION_NOT_FOUND');
  return application;
}
function requireReason(reason: string): string {
  const trimmed = reason.trim();
  if (trimmed.length < 1 || trimmed.length > 300) throw new AttachmentError('REASON_REQUIRED');
  return trimmed;
}
/** Erros dos gatilhos do banco viram um erro tipado, sem repassar o texto do SQLite. */
function guarded<T>(fn: () => T): T {
  try {
    return fn();
  } catch (error) {
    if (error instanceof AttachmentError) throw error;
    if (error instanceof Error && error.name === 'SqliteError') {
      throw new AttachmentError('STATE_NOT_ALLOWED');
    }
    throw error;
  }
}

/**
 * Cria o vínculo EM PREPARAÇÃO. Com um vínculo vivo: aprovado → bloqueia sempre; em preparação →
 * bloqueia, a menos que `replace` seja explícito (o anterior vira `substituido`, no histórico).
 */
export function createAttachment(
  db: Db,
  options: { applicationId: number; artifactId: number; replace?: boolean; now?: Date },
): number {
  const now = options.now ?? new Date();
  return guarded(() =>
    db
      .transaction((): number => {
        const application = requireApplication(db, options.applicationId);
        if (application.status !== 'preparada')
          throw new AttachmentError('APPLICATION_NOT_PREPARED');
        const artifact = db
          .prepare('SELECT variant FROM cv_artifacts WHERE id = ?')
          .get(options.artifactId) as { variant: string } | undefined;
        if (artifact === undefined) throw new AttachmentError('STATE_NOT_ALLOWED');
        const live = db
          .prepare(
            "SELECT id, state FROM application_cv_attachments WHERE application_id = ? AND state IN ('em_preparacao', 'aprovado')",
          )
          .get(options.applicationId) as { id: number; state: AttachmentState } | undefined;
        if (live !== undefined) {
          if (live.state === 'aprovado' || options.replace !== true)
            throw new AttachmentError('LIVE_LINK_EXISTS');
          db.prepare(
            "UPDATE application_cv_attachments SET state = 'substituido', superseded_at = ? WHERE id = ?",
          ).run(now.toISOString(), live.id);
        }
        const id = Number(
          db
            .prepare(
              `INSERT INTO application_cv_attachments (application_id, job_id, artifact_id, variant, state, created_at)
               VALUES (?, ?, ?, ?, 'em_preparacao', ?)`,
            )
            .run(
              options.applicationId,
              application.jobId,
              options.artifactId,
              artifact.variant,
              now.toISOString(),
            ).lastInsertRowid,
        );
        annotateApplication(
          db,
          options.applicationId,
          {
            reason: `vínculo de currículo (${artifact.variant}) criado em preparação${live === undefined ? '' : ' (substitui o anterior)'}; ainda não aprovado; nada foi enviado`,
            actor: 'usuario',
          },
          now,
        );
        return id;
      })
      .immediate(),
  );
}

type Decision = {
  applicationId: number;
  confirmSha8: string;
  reason: string;
  now?: Date;
  /**
   * Vínculo e PDF que o chamador reverificou. Conferidos DENTRO da transação: se o vínculo vivo mudou
   * depois da reverificação, a operação falha sem alterar nada.
   */
  expected?: { linkId: number; pdfSha256: string };
};

function confirmed(view: { pdfSha8: string }, confirmSha8: string): void {
  if (!/^[0-9a-f]{8}$/u.test(confirmSha8) || confirmSha8 !== view.pdfSha8)
    throw new AttachmentError('CONFIRMATION_MISMATCH');
}

/**
 * Aprovação explícita do vínculo (ação própria): confirma o artefato exato (--sha8) e dá um motivo.
 * NÃO aprova a candidatura para envio e NÃO autoriza nenhum e-mail.
 */
export function approveAttachment(db: Db, options: Decision): AttachmentView {
  const now = options.now ?? new Date();
  const reason = requireReason(options.reason);
  return guarded(() =>
    db
      .transaction((): AttachmentView => {
        requireApplication(db, options.applicationId);
        const live = liveAttachment(db, options.applicationId);
        if (live === undefined || live.state !== 'em_preparacao')
          throw new AttachmentError('NO_PREPARING_LINK');
        confirmed(live, options.confirmSha8);
        if (
          options.expected !== undefined &&
          (options.expected.linkId !== live.id || options.expected.pdfSha256 !== live.pdfSha256)
        )
          throw new AttachmentError('CONFIRMATION_MISMATCH');
        db.prepare(
          "UPDATE application_cv_attachments SET state = 'aprovado', approved_at = ?, approval_reason = ? WHERE id = ?",
        ).run(now.toISOString(), reason, live.id);
        annotateApplication(
          db,
          options.applicationId,
          {
            reason: `vínculo de currículo (${live.variant}, ${live.pdfSha8}) aprovado pelo proprietário; isto NÃO aprova nem autoriza envio`,
            actor: 'usuario',
          },
          now,
        );
        return listAttachments(db, options.applicationId).find(
          (v) => v.id === live.id,
        ) as AttachmentView;
      })
      .immediate(),
  );
}

/** Revogação explícita, com motivo. Preserva o histórico; o vínculo revogado nunca volta a valer. */
export function revokeAttachment(db: Db, options: Decision): AttachmentView {
  const now = options.now ?? new Date();
  const reason = requireReason(options.reason);
  return guarded(() =>
    db
      .transaction((): AttachmentView => {
        requireApplication(db, options.applicationId);
        const live = liveAttachment(db, options.applicationId);
        if (live === undefined || live.state !== 'aprovado')
          throw new AttachmentError('NO_APPROVED_LINK');
        confirmed(live, options.confirmSha8);
        db.prepare(
          "UPDATE application_cv_attachments SET state = 'revogado', revoked_at = ?, revocation_reason = ? WHERE id = ?",
        ).run(now.toISOString(), reason, live.id);
        annotateApplication(
          db,
          options.applicationId,
          {
            reason: `vínculo de currículo (${live.variant}, ${live.pdfSha8}) REVOGADO pelo proprietário; autorizações de envio pendentes foram invalidadas`,
            actor: 'usuario',
          },
          now,
        );
        return listAttachments(db, options.applicationId).find(
          (v) => v.id === live.id,
        ) as AttachmentView;
      })
      .immediate(),
  );
}

// ------------------------------------------------------------------ resolução do anexo

/** Vínculo aprovado (única fonte do anexo quando existe). Dados do artefato registrado, não prova de integridade. */
export interface ApprovedLinkRef {
  id: number;
  applicationId: number;
  jobId: number;
  artifactId: number;
  variant: string;
  pdfSha256: string;
  pdfBytes: number;
  modelHash: string;
  fileName: string;
}

/**
 * Qual currículo uma candidatura deve anexar, segundo o BANCO:
 *  - `mestre`: nenhum vínculo jamais existiu (candidatura antiga) → currículo mestre aprovado;
 *  - `aprovado`: há vínculo aprovado → ele é a fonte obrigatória do anexo;
 *  - `bloqueado`: há histórico de vínculo, mas nenhum aprovado e utilizável (em preparação, revogado
 *    ou substituído) → nunca há fallback para o mestre; exige resolução explícita.
 */
export type AttachmentClassification =
  | { kind: 'mestre' }
  | { kind: 'aprovado'; link: ApprovedLinkRef }
  | { kind: 'bloqueado'; states: AttachmentState[] };

export function classifyAttachment(db: Db, applicationId: number): AttachmentClassification {
  const rows = db
    .prepare(
      `SELECT l.id, l.application_id, l.job_id, l.artifact_id, l.variant, l.state,
              a.pdf_sha256, a.pdf_bytes, a.model_hash, a.file_name
         FROM application_cv_attachments l JOIN cv_artifacts a ON a.id = l.artifact_id
        WHERE l.application_id = ? ORDER BY l.id`,
    )
    .all(applicationId) as {
    id: number;
    application_id: number;
    job_id: number;
    artifact_id: number;
    variant: string;
    state: AttachmentState;
    pdf_sha256: string;
    pdf_bytes: number;
    model_hash: string;
    file_name: string;
  }[];
  if (rows.length === 0) return { kind: 'mestre' };
  const approved = rows.find((row) => row.state === 'aprovado');
  if (approved === undefined) return { kind: 'bloqueado', states: rows.map((row) => row.state) };
  return {
    kind: 'aprovado',
    link: {
      id: approved.id,
      applicationId: approved.application_id,
      jobId: approved.job_id,
      artifactId: approved.artifact_id,
      variant: approved.variant,
      pdfSha256: approved.pdf_sha256,
      pdfBytes: approved.pdf_bytes,
      modelHash: approved.model_hash,
      fileName: approved.file_name,
    },
  };
}

/**
 * Anexo personalizado já resolvido: bytes gerados e validados EM MEMÓRIA pelo fluxo estrito agora.
 * Quem consome (preflight) ainda confere tudo contra o banco e recalcula o SHA-256 dos bytes.
 */
export interface ResolvedAttachment {
  applicationId: number;
  jobId: number;
  linkId: number;
  variant: string;
  pdfSha256: string;
  modelHash: string;
  fileName: string;
  bytes: Buffer;
}
