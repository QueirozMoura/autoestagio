import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveFromRoot } from '../../utils/paths.js';

/**
 * Lato (SIL OFL-1.1) versionada no repositório: o PDF não depende de fonte instalada no sistema.
 * A licença acompanha os arquivos (assets/fonts/lato/OFL.txt).
 */
export const FONT_DIR = resolveFromRoot(join('assets', 'fonts', 'lato'));
export const FONT_FILES = {
  regular: 'Lato-Regular.ttf',
  bold: 'Lato-Bold.ttf',
  italic: 'Lato-Italic.ttf',
} as const;
export const FONT_LICENSE_FILE = join(FONT_DIR, 'OFL.txt');

export interface FontSet {
  regular: Buffer;
  bold: Buffer;
  italic: Buffer;
}

export class FontLoadError extends Error {
  constructor(readonly file: string) {
    super(`Fonte não encontrada ou ilegível: ${file}`);
    this.name = 'FontLoadError';
  }
}

let cached: FontSet | undefined;

/** Carrega (uma vez) os três arquivos da fonte, como bytes. */
export function loadFonts(): FontSet {
  if (cached !== undefined) return cached;
  const read = (name: string): Buffer => {
    const file = join(FONT_DIR, name);
    try {
      return readFileSync(file);
    } catch {
      throw new FontLoadError(file);
    }
  };
  cached = {
    regular: read(FONT_FILES.regular),
    bold: read(FONT_FILES.bold),
    italic: read(FONT_FILES.italic),
  };
  return cached;
}
