import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  ModelExistsError,
  buildReport,
  formatReport,
  loadModel,
  saveModel,
  saveReport,
} from '../../src/cv/index.js';
import { PROJECT_ROOT } from '../../src/utils/paths.js';
import { loadFictional, type Loaded } from '../helpers/cv-fixture.js';
import { baseProfile } from '../helpers/eligibility.js';
import { makeFictionalMasterPdf } from '../helpers/master-pdf.js';

let L: Loaded;
beforeAll(async () => {
  L = await loadFictional();
});
const dirs: string[] = [];
const tmp = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'cvstore-'));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const sha = (file: string): string => createHash('sha256').update(readFileSync(file)).digest('hex');

describe('armazenamento local do modelo (dados pessoais)', () => {
  it('grava com permissão 0600 em pasta 0700 e lê de volta idêntico', () => {
    const path = join(tmp(), 'sub', 'cv-master.json');
    saveModel(path, L.enriched);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(join(path, '..')).mode & 0o777).toBe(0o700);
    expect(loadModel(path)).toEqual(L.enriched);
  });

  it('não sobrescreve sem --force; com --force mantém o anterior como .bak (também 0600)', () => {
    const path = join(tmp(), 'cv-master.json');
    saveModel(path, L.enriched);
    expect(() => {
      saveModel(path, L.enriched);
    }).toThrow(ModelExistsError);
    const first = readFileSync(path, 'utf8');
    saveModel(path, L.model, { overwrite: true });
    expect(readFileSync(`${path}.bak`, 'utf8')).toBe(first);
    expect(statSync(`${path}.bak`).mode & 0o777).toBe(0o600);
  });

  it('arquivo adulterado com aprovação inconsistente é recusado ao carregar', () => {
    const path = join(tmp(), 'cv-master.json');
    saveModel(path, L.enriched);
    const tampered = JSON.parse(readFileSync(path, 'utf8')) as {
      summary: { variants: { status: string }[] };
    };
    const variant = tampered.summary.variants[0];
    if (variant) variant.status = 'aprovado';
    writeFileSync(path, JSON.stringify(tampered));
    expect(() => loadModel(path)).toThrow();
    expect(loadModel(join(tmp(), 'nao-existe.json'))).toBeUndefined();
  });

  it('o relatório é gravado com 0600', () => {
    const file = saveReport(
      join(tmp(), 'cv-reports'),
      { ok: true },
      new Date('2026-10-22T12:00:00Z'),
    );
    expect(file).toMatch(/cv-report\.20261022T120000\.json$/);
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it('o modelo e o relatório estão no .gitignore (o relatório fica em data/, ignorado)', () => {
    const ignore = readFileSync(join(PROJECT_ROOT, '.gitignore'), 'utf8');
    expect(ignore).toContain('config/cv-master.json');
    expect(ignore).toContain('config/cv-master.json.bak');
    expect(ignore).toMatch(/^data\/\*$/m);
  });
});

describe('relatório', () => {
  it('resume fidelidade, afirmações, propostas e deixa claro que nada foi aprovado', () => {
    const report = buildReport({
      model: L.enriched,
      extraction: L.extraction,
      now: new Date('2026-10-22T12:00:00Z'),
    });
    expect(report.fidelity.verdict).toBe('fiel');
    expect(report.approval).toEqual({
      modelApproved: false,
      blocksApproved: 0,
      blocksTotal: expect.any(Number) as number,
      linksConfirmed: 0,
      linksTotal: 8,
    });
    expect(report.proposals.problems).toEqual([]);
    const text = formatReport(report, L.enriched);
    expect(text).toContain('FIDELIDADE');
    expect(text).toContain('AFIRMAÇÕES QUE PRECISAM DA SUA CONFIRMAÇÃO');
    expect(text).toContain('PROPOSTAS');
    expect(text).toContain('NÃO APROVADAS');
    expect(text).toContain('Modelo aprovado: NÃO');
    expect(text).toContain('Nada foi aprovado, corrigido ou enviado');
    expect(text).not.toMatch(/Modelo aprovado: sim/);
  });
});

describe('CLI "cv" (processo real, em pasta temporária)', () => {
  const run = (
    args: string[],
    env: Record<string, string>,
    expectFail = false,
  ): { out: string; code: number } => {
    try {
      const out = execFileSync(
        process.execPath,
        ['--import', 'tsx', join(PROJECT_ROOT, 'src', 'cli', 'index.ts'), ...args],
        {
          cwd: PROJECT_ROOT,
          env: { ...process.env, ...env, NODE_NO_WARNINGS: '1' },
          encoding: 'utf8',
          timeout: 60_000,
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );
      return { out, code: 0 };
    } catch (error) {
      if (!expectFail) throw error;
      const e = error as { stdout?: string; stderr?: string; status?: number };
      return { out: `${e.stdout ?? ''}${e.stderr ?? ''}`, code: e.status ?? 1 };
    }
  };

  it('extract → status → report: grava só o modelo (0600), não toca no PDF nem no perfil, e nada fica aprovado', async () => {
    const dir = tmp();
    const pdf = join(dir, 'mestre.pdf');
    writeFileSync(pdf, await makeFictionalMasterPdf(), { mode: 0o444 });
    const profileFile = join(dir, 'profile.json');
    writeFileSync(profileFile, JSON.stringify(baseProfile));
    const env = {
      DATABASE_PATH: join(dir, 'db', 'x.db'),
      PROFILE_PATH: profileFile,
      CV_MODEL_PATH: join(dir, 'cv-master.json'),
    };
    const before = { pdf: sha(pdf), profile: sha(profileFile) };

    const extract = run(['cv', 'extract', '--pdf', pdf], env);
    expect(extract.out).toContain('0600, fora do Git');
    expect(extract.out).toContain('Nada foi aprovado');
    expect(statSync(env.CV_MODEL_PATH).mode & 0o777).toBe(0o600);

    const status = run(['cv', 'status'], env).out;
    expect(status).toContain('Modelo aprovado: NÃO');
    expect(status).toMatch(/Blocos aprovados: 0\/\d+/);
    expect(status).toMatch(/Links confirmados: 0\/8/);
    expect(status).toMatch(/Afirmações pendentes: (\d+)\/\1/);

    const report = run(['cv', 'report', '--pdf', pdf], env).out;
    expect(report).toContain('Veredito: FIEL');
    expect(report).toContain('Relatório gravado em');
    const reportsDir = join(dir, 'db', 'cv-reports');
    expect(readdirSync(reportsDir).some((f) => f.startsWith('cv-report.'))).toBe(true);

    const model = loadModel(env.CV_MODEL_PATH);
    expect(model?.approval).toBeUndefined();
    expect(JSON.stringify(model)).not.toContain('"status": "aprovado"');
    expect({ pdf: sha(pdf), profile: sha(profileFile) }).toEqual(before);
  }, 120_000);

  it('extract não sobrescreve um modelo existente sem --force', async () => {
    const dir = tmp();
    const pdf = join(dir, 'mestre.pdf');
    writeFileSync(pdf, await makeFictionalMasterPdf());
    const env = {
      DATABASE_PATH: join(dir, 'db', 'x.db'),
      PROFILE_PATH: join(dir, 'nao-existe.json'),
      CV_MODEL_PATH: join(dir, 'cv-master.json'),
    };
    run(['cv', 'extract', '--pdf', pdf], env);
    const second = run(['cv', 'extract', '--pdf', pdf], env, true);
    expect(second.code).not.toBe(0);
    expect(second.out).toMatch(/use --force/);
    run(['cv', 'extract', '--pdf', pdf, '--force'], env);
    expect(existsSync(`${env.CV_MODEL_PATH}.bak`)).toBe(true);
  }, 120_000);

  it('sem modelo, o report e o status orientam o próximo passo', () => {
    const dir = tmp();
    const env = {
      DATABASE_PATH: join(dir, 'x.db'),
      PROFILE_PATH: join(dir, 'p.json'),
      CV_MODEL_PATH: join(dir, 'nenhum.json'),
    };
    expect(run(['cv', 'status'], env).out).toContain('Rode "cv extract"');
    const report = run(['cv', 'report', '--pdf', join(dir, 'x.pdf')], env, true);
    expect(report.code).not.toBe(0);
    expect(report.out).toMatch(/cv extract/);
  }, 60_000);
});
