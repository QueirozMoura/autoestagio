import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { cvMasterSchema, type CvMaster } from './schema.js';

/**
 * O modelo guarda dados pessoais: arquivo local com permissão 0600 (pasta 0700), fora do Git
 * (`config/cv-master.json` está no .gitignore).
 */
export class ModelExistsError extends Error {
  constructor(path: string) {
    super(
      `O modelo já existe em ${path}; use --force para regerar (a versão atual será mantida como .bak).`,
    );
    this.name = 'ModelExistsError';
  }
}

function writePrivate(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, content, { mode: 0o600 });
  chmodSync(temp, 0o600);
  renameSync(temp, path);
}

export function saveModel(
  path: string,
  model: CvMaster,
  options: { overwrite?: boolean } = {},
): void {
  if (existsSync(path)) {
    if (options.overwrite !== true) throw new ModelExistsError(path);
    writePrivate(`${path}.bak`, readFileSync(path, 'utf8'));
  }
  writePrivate(path, `${JSON.stringify(cvMasterSchema.parse(model), null, 2)}\n`);
}

export function loadModel(path: string): CvMaster | undefined {
  if (!existsSync(path)) return undefined;
  return cvMasterSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
}

export function saveReport(dir: string, report: unknown, now: Date = new Date()): string {
  const file = join(dir, `cv-report.${now.toISOString().replace(/[-:]/g, '').slice(0, 15)}.json`);
  writePrivate(file, `${JSON.stringify(report, null, 2)}\n`);
  return file;
}
