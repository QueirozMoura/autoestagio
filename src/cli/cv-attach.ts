import { getApplication } from '../applications/index.js';
import type { Db } from '../db/index.js';
import { classifyJobAreas } from '../eligibility/areas.js';
import {
  AttachmentError,
  classifyAttachment,
  type ResolvedAttachment,
  approveAttachment,
  createAttachment,
  liveAttachment,
  registerArtifact,
  revokeAttachment,
  type AttachmentView,
} from '../cv/attachments.js';
import { cvMasterSchema, modelHash } from '../cv/schema.js';
import {
  CV_VARIANTS,
  StrictInputsError,
  loadStrictInputs,
  type StrictInputsOptions,
} from '../cv/strict-inputs.js';
import { renderAndValidateResume, type StrictResumeResult } from '../cv/strict.js';
import { outputFileName, publishable } from './cv-generate.js';
import { createHash } from 'node:crypto';

export interface AttachDeps {
  /** Única porta de geração estrita; substituível apenas nos testes. */
  render?: (input: Parameters<typeof renderAndValidateResume>[0]) => Promise<StrictResumeResult>;
  now?: () => Date;
}

export type AttachStage = 'candidatura' | 'entrada' | 'carregamento' | 'validacao' | 'registro';
export type AttachFailure = {
  ok: false;
  stage: AttachStage;
  code: string;
  message: string;
  /** Sugestão da área da vaga; NUNCA é selecionada automaticamente. */
  suggestion?: { variant: string; reason: string };
};
const fail = (
  stage: AttachStage,
  code: string,
  message: string,
  suggestion?: AttachFailure['suggestion'],
): AttachFailure => ({
  ok: false,
  stage,
  code,
  message,
  ...(suggestion === undefined ? {} : { suggestion }),
});

const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
const VARIANT_BY_AREA = new Map<string, string>(
  CV_VARIANTS.flatMap((v) => (v.area === null ? [] : [[v.area, v.id] as [string, string]])),
);

/** Sugere (não seleciona) uma variante a partir da área da vaga. Ambíguo ou sem variante → genérico. */
export function suggestVariant(
  title: string,
  description: string | null,
): { variant: string; reason: string } {
  const areas = classifyJobAreas(title, description);
  const candidates = (areas.fromTitle.length > 0 ? areas.fromTitle : areas.fromDescription)
    .map((area) => VARIANT_BY_AREA.get(area))
    .filter((id): id is string => id !== undefined);
  const unique = [...new Set(candidates)];
  const only = unique[0];
  if (unique.length === 1 && only !== undefined)
    return { variant: only, reason: 'área identificada no texto da vaga' };
  return {
    variant: 'generico',
    reason:
      unique.length > 1
        ? 'a vaga cita mais de uma área com variante'
        : 'nenhuma área com variante aprovada identificada',
  };
}

export interface StrictArtifact {
  pdfSha256: string;
  pdfBytes: number;
  pages: number;
  modelHash: string;
  variant: string;
  /** Os bytes efetivamente validados (mesma cópia atestada pelo fluxo estrito). */
  bytes: Buffer;
}

/** Geração estrita EM MEMÓRIA: nenhum arquivo em disco é lido como PDF nem gravado. */
export async function regenerateStrict(
  inputs: StrictInputsOptions,
  variantId: string,
  deps: AttachDeps = {},
): Promise<{ ok: true; artifact: StrictArtifact } | AttachFailure> {
  const render = deps.render ?? renderAndValidateResume;
  let result: StrictResumeResult;
  let model: string;
  try {
    const input = loadStrictInputs(inputs).inputFor(variantId);
    model = modelHash(cvMasterSchema.parse(input.model));
    result = await render(input);
  } catch (error) {
    if (error instanceof StrictInputsError)
      return fail('carregamento', error.code, `${error.message} Nada foi registrado.`);
    return fail(
      'validacao',
      'UNEXPECTED',
      'Falha inesperada na geração estrita. Nada foi registrado.',
    );
  }
  const artifact = result.artifact;
  if (!publishable(result) || artifact === undefined)
    return fail(
      'validacao',
      'VALIDATION_FAILED',
      'A validação estrita não foi concluída. Nada foi registrado.',
    );
  const bytes = artifact.readBytes();
  const digest = sha256(bytes);
  if (digest !== artifact.pdfSha256)
    return fail(
      'validacao',
      'ARTIFACT_HASH_MISMATCH',
      'Os bytes não correspondem ao hash atestado. Nada foi registrado.',
    );
  return {
    ok: true,
    artifact: {
      pdfSha256: digest,
      pdfBytes: bytes.length,
      pages: artifact.pages,
      modelHash: model,
      variant: variantId,
      bytes,
    },
  };
}

export type AttachOutcome =
  | {
      ok: true;
      applicationId: number;
      variant: string;
      state: 'em_preparacao';
      pages: number;
      pdfSha8: string;
      artifactRegistered: boolean;
      replaced: boolean;
    }
  | AttachFailure;

function attachmentFailure(error: unknown): AttachFailure {
  if (error instanceof AttachmentError) return fail('registro', error.code, error.message);
  throw error;
}

export interface AttachRequest {
  db: Db;
  applicationId: number;
  /** Opcional: confere que a candidatura é da vaga esperada. */
  jobId?: number;
  variant: string | undefined;
  inputs: StrictInputsOptions;
  replace?: boolean;
}

/** `cv attach`: gera (em memória), valida, registra o artefato e cria o vínculo EM PREPARAÇÃO. */
export async function attachResume(
  request: AttachRequest,
  deps: AttachDeps = {},
): Promise<AttachOutcome> {
  const { db } = request;
  const application = getApplication(db, request.applicationId);
  if (application === undefined)
    return fail('candidatura', 'APPLICATION_NOT_FOUND', 'Candidatura inexistente.');
  const job = db
    .prepare('SELECT title, description FROM jobs WHERE id = ?')
    .get(application.jobId) as { title: string; description: string | null } | undefined;
  if (job === undefined)
    return fail('candidatura', 'JOB_NOT_FOUND', 'Vaga da candidatura inexistente.');
  if (request.jobId !== undefined && request.jobId !== application.jobId)
    return fail('candidatura', 'JOB_MISMATCH', 'A candidatura não pertence à vaga informada.');
  if (application.status !== 'preparada')
    return fail(
      'candidatura',
      'APPLICATION_NOT_PREPARED',
      'A candidatura precisa estar "preparada" para receber um vínculo.',
    );

  const suggestion = suggestVariant(job.title, job.description);
  const variant = CV_VARIANTS.find((v) => v.id === request.variant);
  if (variant === undefined)
    return fail(
      'entrada',
      request.variant === undefined ? 'VARIANT_REQUIRED' : 'VARIANT_UNKNOWN',
      `Informe a variante com --variant (${CV_VARIANTS.map((v) => v.id).join(', ')}). Sugestão para esta vaga: ${suggestion.variant} (${suggestion.reason}); a sugestão NÃO é aplicada.`,
      suggestion,
    );
  const live = liveAttachment(db, request.applicationId);
  if (live !== undefined && (live.state === 'aprovado' || request.replace !== true))
    return fail('registro', 'LIVE_LINK_EXISTS', new AttachmentError('LIVE_LINK_EXISTS').message);

  const strict = await regenerateStrict(request.inputs, variant.id, deps);
  if (!strict.ok) return strict;
  const now = (deps.now ?? (() => new Date()))();
  const { artifact } = strict;
  try {
    // Registro do artefato e criação do vínculo são UMA transação: ou ficam os dois, ou nenhum.
    const registered = db
      .transaction(() => {
        const artifactRow = registerArtifact(db, {
          variant: variant.id,
          pdfSha256: artifact.pdfSha256,
          pdfBytes: artifact.pdfBytes,
          pages: artifact.pages,
          modelHash: artifact.modelHash,
          generatedAt: now,
          fileName: outputFileName(variant.id, artifact.pdfSha256, now),
        });
        createAttachment(db, {
          applicationId: request.applicationId,
          artifactId: artifactRow.id,
          ...(request.replace === true ? { replace: true } : {}),
          now,
        });
        return artifactRow;
      })
      .immediate();
    return {
      ok: true,
      applicationId: request.applicationId,
      variant: variant.id,
      state: 'em_preparacao',
      pages: artifact.pages,
      pdfSha8: artifact.pdfSha256.slice(0, 8),
      artifactRegistered: registered.created,
      replaced: live !== undefined,
    };
  } catch (error) {
    return attachmentFailure(error);
  }
}

export type DecisionOutcome =
  { ok: true; action: 'aprovado' | 'revogado'; view: AttachmentView } | AttachFailure;

/**
 * `cv attachment approve`: reverifica o artefato pela geração estrita ANTES de aprovar. Se o PDF
 * regenerado (ou o modelo aprovado) divergir do registrado, bloqueia sem alterar nada.
 */
export async function approveResumeLink(
  request: {
    db: Db;
    applicationId: number;
    confirmSha8: string;
    reason: string;
    inputs: StrictInputsOptions;
  },
  deps: AttachDeps = {},
): Promise<DecisionOutcome> {
  const live = liveAttachment(request.db, request.applicationId);
  if (live === undefined || live.state !== 'em_preparacao')
    return fail('registro', 'NO_PREPARING_LINK', new AttachmentError('NO_PREPARING_LINK').message);
  const strict = await regenerateStrict(request.inputs, live.variant, deps);
  if (!strict.ok) return strict;
  if (strict.artifact.pdfSha256 !== live.pdfSha256 || strict.artifact.modelHash !== live.modelHash)
    return fail(
      'validacao',
      'ARTIFACT_HASH_DIVERGENT',
      'O PDF regenerado (ou o modelo aprovado) difere do artefato registrado. Nada foi aprovado nem atualizado.',
    );
  try {
    const view = approveAttachment(request.db, {
      applicationId: request.applicationId,
      confirmSha8: request.confirmSha8,
      reason: request.reason,
      expected: { linkId: live.id, pdfSha256: live.pdfSha256 },
      ...(deps.now === undefined ? {} : { now: deps.now() }),
    });
    return { ok: true, action: 'aprovado', view };
  } catch (error) {
    return attachmentFailure(error);
  }
}

/** `cv attachment revoke`: explícito, com motivo e confirmação do artefato; não exige regeneração. */
export function revokeResumeLink(
  request: { db: Db; applicationId: number; confirmSha8: string; reason: string },
  deps: AttachDeps = {},
): DecisionOutcome {
  try {
    const view = revokeAttachment(request.db, {
      applicationId: request.applicationId,
      confirmSha8: request.confirmSha8,
      reason: request.reason,
      ...(deps.now === undefined ? {} : { now: deps.now() }),
    });
    return { ok: true, action: 'revogado', view };
  } catch (error) {
    return attachmentFailure(error);
  }
}

const STATE_LABEL: Record<string, string> = {
  em_preparacao: 'em preparação (NÃO aprovado)',
  aprovado: 'aprovado (não autoriza envio)',
  revogado: 'revogado',
  substituido: 'substituído',
};

export function formatAttachment(outcome: AttachOutcome | DecisionOutcome): string {
  if (!outcome.ok) {
    const hint =
      outcome.suggestion === undefined
        ? ''
        : `\nSugestão (não aplicada): ${outcome.suggestion.variant}`;
    return `Falha (${outcome.stage}, código ${outcome.code}): ${outcome.message}${hint}`;
  }
  if ('action' in outcome)
    return [
      `Vínculo de currículo ${outcome.action}: candidatura #${outcome.view.applicationId}, variante ${outcome.view.variant}, PDF ${outcome.view.pdfSha8}`,
      outcome.action === 'aprovado'
        ? 'Isto NÃO aprova a candidatura para envio e NÃO autoriza nenhum e-mail.'
        : 'O vínculo foi encerrado para sempre; um novo vínculo exige nova seleção e nova aprovação. Autorizações de envio pendentes foram invalidadas.',
    ].join('\n');
  return [
    `Vínculo de currículo criado: candidatura #${outcome.applicationId}, variante ${outcome.variant}`,
    `PDF validado (estrito, em memória): ${outcome.pages} página(s), identificador ${outcome.pdfSha8}`,
    `Artefato: ${outcome.artifactRegistered ? 'registrado agora' : 'já registrado (mesmo hash)'}${outcome.replaced ? '; vínculo provisório anterior substituído' : ''}`,
    `Estado: ${STATE_LABEL[outcome.state] ?? outcome.state}`,
    `Para aprovar: cv attachment approve ${outcome.applicationId} --sha8 ${outcome.pdfSha8} --reason "..." --ancora-sha256 <hash>`,
    'Nenhum e-mail foi enviado ou preparado.',
  ].join('\n');
}

export function formatAttachmentList(
  views: readonly AttachmentView[],
  applicationId: number,
): string {
  if (views.length === 0)
    return `Candidatura #${applicationId}: sem vínculo de currículo (usa o currículo mestre).`;
  return [
    `Vínculos de currículo da candidatura #${applicationId}:`,
    ...views.map(
      (v) =>
        `  #${v.id} ${v.variant} PDF ${v.pdfSha8} modelo ${v.modelHash8} ${v.pages} pág. — ${STATE_LABEL[v.state] ?? v.state}`,
    ),
  ].join('\n');
}

export type ResolveOutcome =
  { ok: true; attachment: ResolvedAttachment | undefined } | AttachFailure;

/**
 * Função central que resolve o currículo a anexar (sem tocar em Gmail nem em disco):
 *  - candidatura antiga sem vínculo → `attachment: undefined` (usa o mestre, como antes);
 *  - vínculo aprovado → regenera em memória pelo fluxo estrito e exige variante, modelo e SHA-256
 *    completo idênticos aos registrados; usa SÓ os bytes validados; divergência bloqueia e NADA é atualizado;
 *  - histórico sem vínculo aprovado → bloqueio explícito (sem fallback para o mestre).
 */
export async function resolveApprovedAttachment(
  request: { db: Db; applicationId: number; inputs: StrictInputsOptions },
  deps: AttachDeps = {},
): Promise<ResolveOutcome> {
  const application = getApplication(request.db, request.applicationId);
  if (application === undefined)
    return fail('candidatura', 'APPLICATION_NOT_FOUND', 'Candidatura inexistente.');
  const classification = classifyAttachment(request.db, request.applicationId);
  if (classification.kind === 'mestre') return { ok: true, attachment: undefined };
  if (classification.kind === 'bloqueado')
    return fail(
      'registro',
      'NO_APPROVED_LINK_USABLE',
      'A candidatura tem histórico de vínculo de currículo, mas nenhum vínculo aprovado e utilizável (em preparação, revogado ou substituído). O currículo mestre NÃO será usado como substituto: aprove um vínculo (cv attachment approve) ou resolva explicitamente.',
    );
  const { link } = classification;
  if (link.jobId !== application.jobId)
    return fail('candidatura', 'JOB_MISMATCH', 'O vínculo não pertence à vaga da candidatura.');
  const strict = await regenerateStrict(request.inputs, link.variant, deps);
  if (!strict.ok) return strict;
  const { artifact } = strict;
  if (artifact.variant !== link.variant)
    return fail(
      'validacao',
      'VARIANT_MISMATCH',
      'Variante regenerada difere da vinculada. Nada foi atualizado.',
    );
  if (artifact.modelHash !== link.modelHash)
    return fail(
      'validacao',
      'MODEL_DIVERGENT',
      'O modelo editorial aprovado mudou desde o registro do artefato. Nada foi atualizado; crie e aprove um novo vínculo.',
    );
  if (artifact.pdfSha256 !== link.pdfSha256 || sha256(artifact.bytes) !== link.pdfSha256)
    return fail(
      'validacao',
      'ARTIFACT_HASH_DIVERGENT',
      'O PDF regenerado difere do artefato aprovado. Nada foi atualizado nem anexado.',
    );
  return {
    ok: true,
    attachment: {
      applicationId: request.applicationId,
      jobId: application.jobId,
      linkId: link.id,
      variant: link.variant,
      pdfSha256: link.pdfSha256,
      modelHash: link.modelHash,
      fileName: link.fileName,
      bytes: Buffer.from(artifact.bytes),
    },
  };
}
