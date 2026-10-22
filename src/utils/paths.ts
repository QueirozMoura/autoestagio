import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Raiz do projeto. Funciona tanto em `src/<dir>` quanto em `dist/<dir>`. */
export const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

export function resolveFromRoot(path: string, root: string = PROJECT_ROOT): string {
  return isAbsolute(path) ? path : resolve(root, path);
}
