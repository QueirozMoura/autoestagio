import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { verifyApprovedCv, type Profile } from '../config/index.js';

/**
 * Escolhe o currículo a anexar: o PDF da variante aprovada da vaga (gerado pelo fluxo estrito em data/cv-output),
 * senão o da variante genérica, senão o currículo mestre aprovado no perfil (conferido por SHA-256). Sempre confere
 * que o arquivo é um PDF e informa o hash; nunca gera nem altera currículos.
 */
export interface ChosenCv {
  path: string;
  label: string;
  sha256: string;
  /** Variante realmente usada; "mestre" quando cai no currículo aprovado do perfil. */
  variant: string;
  note: string;
}

const KNOWN = new Set(['generico', 'desenvolvimento', 'qa', 'infraestrutura', 'banco-de-dados']);

const isPdf = (path: string): boolean => {
  try {
    return readFileSync(path).subarray(0, 5).toString('latin1') === '%PDF-';
  } catch {
    return false;
  }
};
const sha = (path: string): string => createHash('sha256').update(readFileSync(path)).digest('hex');

function newestVariantPdf(dir: string, variant: string): string | undefined {
  if (!existsSync(dir)) return undefined;
  const files = readdirSync(dir)
    .filter((f) => f.startsWith(`curriculo-${variant}-`) && f.endsWith('.pdf'))
    .map((f) => ({ path: join(dir, f), time: statSync(join(dir, f)).mtimeMs }))
    .sort((a, b) => b.time - a.time);
  return files.find((f) => isPdf(f.path))?.path;
}

export function chooseCv(options: {
  variant: string | null;
  outputDir: string;
  profile: Profile;
  onlyMaster?: boolean;
}): ChosenCv | null {
  const wanted =
    options.variant !== null && KNOWN.has(options.variant) ? options.variant : 'generico';
  for (const variant of options.onlyMaster === true
    ? []
    : wanted === 'generico'
      ? ['generico']
      : [wanted, 'generico']) {
    const path = newestVariantPdf(options.outputDir, variant);
    if (path !== undefined)
      return {
        path,
        label: basename(path),
        sha256: sha(path),
        variant,
        note:
          variant === wanted
            ? `variante aprovada "${variant}"`
            : `variante "${wanted}" sem PDF gerado: usando a genérica`,
      };
  }
  const master = verifyApprovedCv(options.profile);
  if (master.ok) {
    const path = options.profile.approval?.cvFile ?? '';
    return {
      path,
      label: master.cv.label,
      sha256: master.cv.sha256,
      variant: 'mestre',
      note: 'nenhum PDF de variante: usando o currículo mestre aprovado no perfil',
    };
  }
  return null;
}
