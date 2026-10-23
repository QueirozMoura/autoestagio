import { z } from 'zod';
import { CV_VARIANTS } from './strict-inputs.js';

/**
 * Contratos de dados do registro de artefatos de currículo (migração 0008). Só descrevem as linhas;
 * não há acesso ao banco aqui. Um registro NÃO prova integridade: o PDF precisa ser reverificado pelo
 * fluxo estrito antes de qualquer uso (hash do PDF, hash do modelo aprovado, vaga e variante).
 */
export const ARTIFACT_VALIDATION = 'estrita-completa';
export const ATTACHMENT_STATES = ['em_preparacao', 'aprovado', 'revogado', 'substituido'] as const;
export type AttachmentState = (typeof ATTACHMENT_STATES)[number];

const hex64 = z.string().regex(/^[0-9a-f]{64}$/u);
const variant = z.enum(CV_VARIANTS.map((v) => v.id) as [string, ...string[]]);

export const cvArtifactRowSchema = z.strictObject({
  id: z.number().int().positive(),
  variant,
  pdf_sha256: hex64,
  pdf_bytes: z.number().int().positive(),
  pages: z.number().int().min(1).max(10),
  model_hash: hex64,
  generated_at: z.iso.datetime(),
  validation: z.literal(ARTIFACT_VALIDATION),
  file_name: z.string().regex(/^curriculo-[a-z-]+-\d{8}-[0-9a-f]{8}\.pdf$/u),
});
export type CvArtifactRow = z.infer<typeof cvArtifactRowSchema>;

export const attachmentRowSchema = z.strictObject({
  id: z.number().int().positive(),
  application_id: z.number().int().positive(),
  job_id: z.number().int().positive(),
  artifact_id: z.number().int().positive(),
  variant,
  state: z.enum(ATTACHMENT_STATES),
  created_at: z.iso.datetime(),
  approved_at: z.iso.datetime().nullable(),
  approval_reason: z.string().nullable(),
  revoked_at: z.iso.datetime().nullable(),
  revocation_reason: z.string().nullable(),
  superseded_at: z.iso.datetime().nullable(),
});
export type AttachmentRow = z.infer<typeof attachmentRowSchema>;
