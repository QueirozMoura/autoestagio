import { createHash } from 'node:crypto';
import { z } from 'zod';
import { canonicalJson, cvMasterSchema, modelHash } from './schema.js';

const sha256 = (bytes: Uint8Array | string): string =>
  createHash('sha256').update(bytes).digest('hex');
const hashObject = (value: unknown): string => sha256(canonicalJson(value));
const nonempty = z.string().trim().min(1);
const evidenceSchema = z.strictObject({
  evidenceId: nonempty,
  sha256: z.string().regex(/^[a-f0-9]{64}$/u),
  sizeBytes: z
    .number()
    .int()
    .positive()
    .max(8 * 1024 * 1024),
  observed: z.strictObject({
    courseTitle: nonempty,
    presentedIssuer: nonempty,
    holderName: nonempty,
    documentType: z.literal('Certificate of Completion'),
    completionStatement: z.literal('has completed'),
    completionDate: z.null(),
  }),
  externalAuthenticity: z.literal('not-verified'),
});
const decisionSchema = z.strictObject({
  decisionId: nonempty,
  approvedAt: z.iso.date(),
  recordedAt: z.iso.datetime({ offset: true }),
  by: z.literal('proprietario'),
  source: nonempty,
  editorialText: nonempty,
  scope: z.literal('editorial-documentary-only'),
});

/**
 * Prepara uma reconciliação em memória a partir de observações documentais JÁ conferidas e de
 * uma decisão explícita do proprietário. O hash verifica os bytes; não autentica o emissor nem
 * extrai ou confirma o conteúdo visual. Não carrega arquivos, não decide pelo proprietário e
 * nunca renova a aprovação global. O histórico retornado deve ser preservado pelo chamador.
 */
export function reconcileCertification(input: {
  model: unknown;
  certificationId: string;
  certificateBytes: Uint8Array;
  reviewedEvidence: unknown;
  editorialDecision: unknown;
}) {
  const evidence = evidenceSchema.parse(input.reviewedEvidence);
  const decision = decisionSchema.parse(input.editorialDecision);
  const bytes = Buffer.from(input.certificateBytes);
  if (bytes.length !== evidence.sizeBytes || sha256(bytes) !== evidence.sha256)
    throw new Error('CERTIFICATE_INTEGRITY');
  const { courseTitle: title, presentedIssuer: issuer } = evidence.observed;
  if (decision.editorialText !== `${title} — ${issuer}`)
    throw new Error('CERTIFICATE_EDITORIAL_MISMATCH');
  const model = cvMasterSchema.parse(input.model);
  const cert = model.certifications.find((c) => c.id === input.certificationId);
  if (cert === undefined) throw new Error('CERTIFICATE_NOT_FOUND');
  const previousCertification = structuredClone(cert);
  const previousClaims = structuredClone(model.claims.filter((c) => c.blockId === cert.id));
  const documentaryClaimId = `claim-documental-${cert.id}`;
  if (model.claims.some((c) => c.id === documentaryClaimId))
    throw new Error('CERTIFICATE_ALREADY_RECONCILED');
  const previousApproval = model.approval === undefined ? null : structuredClone(model.approval);
  const beforeModelHash = modelHash(model);
  delete model.approval;
  cert.curated = {
    text: decision.editorialText,
    title,
    issuer,
    withheld: ['year', 'description'],
    approvedAt: decision.approvedAt,
    basis: [
      {
        kind: 'decisao_proprietario',
        ref: decision.decisionId,
        note: 'Redação editorial expressamente aprovada; sem aprovação global.',
      },
      {
        kind: 'evidencia_documental',
        ref: `${evidence.evidenceId}#sha256=${evidence.sha256}`,
        note: 'Conteúdo visual conferido; emissor apresentado, sem autenticação externa. Ano e descrição retidos.',
      },
    ],
  };
  model.claims.push({
    id: documentaryClaimId,
    blockId: cert.id,
    kind: 'certificacao',
    quote: decision.editorialText,
    question: 'Quais título, emissor apresentado e indicação de conclusão constam no documento?',
    status: 'confirmada',
    resolution: {
      at: decision.approvedAt,
      by: decision.by,
      note: 'Reconciliação documental autorizada: o documento apresenta conclusão do curso com este título e emissor. Autenticidade externa não verificada; sem ano, descrição, carga horária ou competências específicas. Não resolve integralmente os claims históricos.',
      basis: structuredClone(cert.curated.basis),
    },
  });
  return {
    model: cvMasterSchema.parse(model),
    newModelHash: modelHash(model),
    history: {
      previousApproval,
      previousCertification,
      previousClaims,
      beforeModelHash,
      previousCertificationSha256: hashObject(previousCertification),
    },
    decision: {
      ...decision,
      certificationId: cert.id,
      documentaryClaimId,
      assertionSha256: hashObject({ title, issuer, scope: decision.scope }),
      evidenceSha256: evidence.sha256,
      evidenceId: evidence.evidenceId,
      reviewedEvidenceSha256: hashObject(evidence),
      externalAuthenticity: evidence.externalAuthenticity,
      globalApproval: 'pending' as const,
    },
  };
}
