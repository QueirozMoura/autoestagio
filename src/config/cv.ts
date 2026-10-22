import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { basename } from 'node:path';
import type { Profile } from './profile.js';

export interface CvReference {
  sha256: string;
  /** Só o nome do arquivo (sem o caminho), para auditoria. */
  label: string;
}

export type CvCheck = { ok: true; cv: CvReference } | { ok: false; reason: string };

export function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

/**
 * Confere se o currículo no disco é exatamente o aprovado no perfil. Se o arquivo sumiu ou foi
 * alterado, a aprovação não vale mais: o currículo enviado seria outro.
 */
export function verifyApprovedCv(profile: Profile): CvCheck {
  const approval = profile.approval;
  if (approval === undefined) return { ok: false, reason: 'perfil sem aprovação' };
  if (!existsSync(approval.cvFile)) {
    return { ok: false, reason: 'currículo aprovado não encontrado no disco' };
  }
  const actual = sha256File(approval.cvFile);
  if (actual !== approval.cvSha256) {
    return { ok: false, reason: 'o currículo no disco difere do aprovado (SHA-256 diferente)' };
  }
  return { ok: true, cv: { sha256: actual, label: basename(approval.cvFile) } };
}
