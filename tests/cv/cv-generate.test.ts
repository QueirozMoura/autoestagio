import {
  chmodSync,
  existsSync,
  fsyncSync as realFsync,
  linkSync as realLink,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { Command } from 'commander';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { registerCvCommands } from '../../src/cli/cv-commands.js';
import {
  formatGenerate,
  generateJson,
  generateResume,
  type GenerateOutcome,
} from '../../src/cli/cv-generate.js';
import { CV_VARIANTS, loadStrictInputs } from '../../src/cv/strict-inputs.js';
import { renderAndValidateResume, type StrictResumeResult } from '../../src/cv/strict.js';
import type { Area } from '../../src/eligibility/areas.js';
import type { SafeWriteFs } from '../../src/utils/safe-write.js';
import { addVariant, DEV, GENERIC } from '../helpers/cv-approved.js';
import { loadFictional, type Loaded } from '../helpers/cv-fixture.js';
import {
  json,
  makeProject,
  sha,
  writePrivate,
  type Project,
} from '../helpers/cv-strict-project.js';

const nn = <T>(value: T | null | undefined): T => {
  if (value === null || value === undefined) throw new Error('valor ausente no teste');
  return value;
};
vi.setConfig({ testTimeout: 120_000 });
const ALL: (Area | null)[] = [null, 'desenvolvimento', 'qa', 'infraestrutura', 'banco-de-dados'];
const INFRA = 'Resumo aprovado de Infraestrutura sintético.';
const BD = 'Resumo aprovado de Banco de Dados sintético.';
let L: Loaded;
let full: Project;
let real: StrictResumeResult;
beforeAll(async () => {
  L = await loadFictional();
  full = makeProject(
    L,
    (m) => {
      addVariant(m.summary, 'resumo-infra', INFRA, 'aprovado', ['infraestrutura']);
      addVariant(m.summary, 'resumo-bd', BD, 'aprovado', ['banco-de-dados']);
    },
    ALL,
  );
  real = await renderAndValidateResume(loadStrictInputs(full.options).inputFor('generico'));
  expect(real.report.issues).toEqual([]);
});
const projects: Project[] = [];
const outs: string[] = [];
afterEach(() => {
  for (const p of projects.splice(0)) rmSync(p.root, { recursive: true, force: true });
  for (const o of outs.splice(0)) rmSync(o, { recursive: true, force: true });
});
const out = (p: Project): string => join(p.root, 'saida');
const names = (dir: string): string[] => (existsSync(dir) ? readdirSync(dir).sort() : []);

/** Resultado "estrito" sintético derivado de um real, com bytes fixos (o hash é recalculado). */
const FAKE = Buffer.from('%PDF-1.7 bytes sinteticos de teste');
function stub(
  edit: (r: StrictResumeResult) => void = () => undefined,
): () => Promise<StrictResumeResult> {
  return () => {
    const result = structuredClone({ report: real.report }) as StrictResumeResult;
    const digest = sha(FAKE);
    const report = nn(result.report.bindings);
    report.pdfSha256 = digest;
    nn(result.report.diagnostic).pdfSha256 = digest;
    result.artifact = {
      pdfSha256: digest,
      pages: nn(real.artifact).pages,
      readBytes: () => Buffer.from(FAKE),
    };
    edit(result);
    return Promise.resolve(result);
  };
}
const request = (p: Project, variant = 'generico', output = out(p)) => ({
  variant,
  inputs: p.options,
  output,
});
const failed = (o: GenerateOutcome) => {
  if (o.ok) throw new Error('deveria falhar');
  return o;
};

describe('cv generate: fluxo real com Poppler', () => {
  it('gera e grava as cinco variantes aprovadas (fixtures sintéticas)', async () => {
    const dir = out(full);
    const seen: string[] = [];
    for (const variant of CV_VARIANTS) {
      const outcome = await generateResume(request(full, variant.id));
      if (!outcome.ok)
        throw new Error(`${variant.id}: ${outcome.code} ${outcome.issues?.join(',')}`);
      expect(outcome).toMatchObject({
        variant: variant.id,
        validation: 'estrita-completa',
        durable: true,
        tempCleanup: 'removed',
      });
      expect(outcome.pages).toBeGreaterThanOrEqual(1);
      expect(outcome.path.startsWith(`${dir}/curriculo-${variant.id}-`)).toBe(true);
      expect(outcome.path).toMatch(/-\d{8}-[a-f0-9]{8}\.pdf$/u);
      expect(statSync(outcome.path).mode & 0o777).toBe(0o600);
      expect(readFileSync(outcome.path).subarray(0, 5).toString()).toBe('%PDF-');
      seen.push(variant.id);
      const text = [formatGenerate(outcome), JSON.stringify(generateJson(outcome))].join('\n');
      for (const secret of [GENERIC, DEV, INFRA, BD, full.anchorSha256, full.model.master.sha256])
        expect(text).not.toContain(secret);
      expect(text.replace(outcome.path, '')).not.toMatch(/[a-f0-9]{32,}/u);
    }
    expect(seen).toHaveLength(5);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(names(dir).filter((n) => n.endsWith('.tmp'))).toEqual([]);
    expect(names(dir)).toHaveLength(5);
    rmSync(dir, { recursive: true, force: true });
  });

  it('usa data/cv-output/ da raiz quando --output não é informado', async () => {
    const outcome = await generateResume({
      variant: 'generico',
      inputs: full.options,
      root: full.root,
    });
    expect(outcome.ok && outcome.path).toBe(
      outcome.ok
        ? join(full.root, 'data', 'cv-output', nn(names(join(full.root, 'data', 'cv-output'))[0]))
        : '',
    );
    expect(statSync(join(full.root, 'data', 'cv-output')).mode & 0o777).toBe(0o700);
    rmSync(join(full.root, 'data', 'cv-output'), { recursive: true, force: true });
  });
});

describe('cv generate: bloqueios antes da renderização', () => {
  const never = vi.fn(() => Promise.reject(new Error('não deveria renderizar')));
  const check = async (p: Project, variant: string, code: string, stage = 'carregamento') => {
    never.mockClear();
    const outcome = failed(await generateResume(request(p, variant), { render: never }));
    expect(outcome).toMatchObject({ stage, code });
    expect(never).not.toHaveBeenCalled();
    expect(names(out(p))).toEqual([]);
    return outcome;
  };

  it('variante inexistente ou ausente', async () => {
    const o = await check(full, 'suporte', 'VARIANT_UNKNOWN', 'entrada');
    expect(o.message).toContain('generico');
    await check(full, '../x', 'VARIANT_UNKNOWN', 'entrada');
    never.mockClear();
    const none = failed(
      await generateResume({ ...request(full), variant: undefined }, { render: never }),
    );
    expect(none.code).toBe('VARIANT_UNKNOWN');
  });

  it('variante não aprovada ou fora do manifesto', async () => {
    const p = makeProject(L);
    projects.push(p);
    await check(p, 'infraestrutura', 'VARIANT_NOT_ELIGIBLE');
    await check(p, 'qa', 'VARIANT_NOT_IN_DECISIONS');
  });

  it('âncora ausente ou incorreta', async () => {
    const p = makeProject(L);
    projects.push(p);
    never.mockClear();
    const missing = failed(
      await generateResume(
        { ...request(p), inputs: { ...p.options, anchorSha256: undefined } },
        { render: never },
      ),
    );
    expect(missing.code).toBe('ANCHOR_REFERENCE_MISSING');
    const wrong = failed(
      await generateResume(
        { ...request(p), inputs: { ...p.options, anchorSha256: sha('errada') } },
        { render: never },
      ),
    );
    expect(wrong.code).toBe('ANCHOR_MISMATCH');
    expect(never).not.toHaveBeenCalled();
  });

  it('aprovação obsoleta e decisões inválidas', async () => {
    let p = makeProject(L);
    projects.push(p);
    const stale = makeProject(L, (m) => {
      nn(m.summary.variants.find((v) => v.id === 'resumo-geral')).text += ' reaprovado';
    });
    projects.push(stale);
    writePrivate(p.paths.model, readFileSync(stale.paths.model));
    await check(p, 'generico', 'APPROVAL_STALE');
    p = makeProject(L);
    projects.push(p);
    const bundle = JSON.parse(readFileSync(p.paths.bundle, 'utf8')) as {
      manifest: { decisions: unknown[] };
    };
    bundle.manifest.decisions.push({ id: 'falsa' });
    writePrivate(p.paths.bundle, json(bundle));
    await check(p, 'generico', 'DECISIONS_INVALID');
  });

  it('Poppler ausente: bloqueia sem renderizar e sem fallback', async () => {
    const p = makeProject(L);
    projects.push(p);
    never.mockClear();
    const o = failed(
      await generateResume(
        {
          ...request(p),
          inputs: { ...p.options, popplerRunner: () => ({ status: null, stdout: '', stderr: '' }) },
        },
        { render: never },
      ),
    );
    expect(o.code).toBe('POPPLER_MISSING');
    expect(never).not.toHaveBeenCalled();
  });
});

describe('cv generate: portão de publicação estrito', () => {
  const cases: [string, (r: StrictResumeResult) => void][] = [
    [
      'complete=false',
      (r) => {
        r.report.complete = false;
        delete r.artifact;
      },
    ],
    [
      'ok=false',
      (r) => {
        r.report.ok = false;
      },
    ],
    [
      'falha em H3',
      (r) => {
        nn(nn(r.report.diagnostic).checks[2]).status = 'fail';
        r.report.issues = ['CHECKS'];
        r.report.ok = false;
        r.report.complete = false;
        delete r.artifact;
      },
    ],
    [
      'H10 ausente',
      (r) => {
        nn(r.report.diagnostic).checks.pop();
      },
    ],
    [
      'Poppler não usado',
      (r) => {
        nn(r.report.diagnostic).extractors = nn(r.report.diagnostic).extractors.filter(
          (e) => e.name !== 'poppler (pdftotext)',
        );
      },
    ],
    [
      'fonte não verificada',
      (r) => {
        r.report.fontIdentity.status = 'pending' as never;
      },
    ],
    [
      'integridade de referências',
      (r) => {
        r.report.referenceIntegrity = 'failed';
      },
    ],
    [
      'issues pendentes',
      (r) => {
        r.report.issues = ['PENDING'];
      },
    ],
    [
      'artefato ausente',
      (r) => {
        delete r.artifact;
      },
    ],
    [
      'sem bindings',
      (r) => {
        r.report.bindings = null;
      },
    ],
    [
      'sem diagnóstico',
      (r) => {
        r.report.diagnostic = null;
      },
    ],
    [
      'hash do binding divergente',
      (r) => {
        nn(r.report.bindings).pdfSha256 = sha('outro');
      },
    ],
    [
      'hash do diagnóstico divergente',
      (r) => {
        nn(r.report.diagnostic).pdfSha256 = sha('outro');
      },
    ],
    [
      'páginas divergentes',
      (r) => {
        nn(r.artifact).pages += 1;
      },
    ],
  ];
  it.each(cases)('não persiste: %s', async (_name, edit) => {
    const p = makeProject(L);
    projects.push(p);
    const write = vi.fn();
    const o = failed(await generateResume(request(p), { render: stub(edit), write }));
    expect(o).toMatchObject({ stage: 'validacao' });
    expect(write).not.toHaveBeenCalled();
    expect(existsSync(out(p))).toBe(false);
    expect(formatGenerate(o)).toContain('nenhum PDF foi publicado');
  });

  it('bytes que não conferem com o hash atestado não são gravados', async () => {
    const p = makeProject(L);
    projects.push(p);
    const o = failed(
      await generateResume(request(p), {
        render: stub((r) => {
          nn(r.artifact).readBytes = () => Buffer.from('adulterado');
        }),
      }),
    );
    expect(o.code).toBe('ARTIFACT_HASH_MISMATCH');
    expect(existsSync(out(p))).toBe(false);
  });

  it('erro inesperado da renderização não vaza detalhes', async () => {
    const p = makeProject(L);
    projects.push(p);
    const o = failed(
      await generateResume(request(p), {
        render: () => Promise.reject(new Error('SEGREDO-PESSOAL /home/x')),
      }),
    );
    expect(o.code).toBe('UNEXPECTED');
    expect(JSON.stringify(o)).not.toContain('SEGREDO');
    expect(existsSync(out(p))).toBe(false);
  });
});

describe('cv generate: gravação', () => {
  const fixedNow = () => new Date(2026, 9, 23, 12);
  const finalName = `curriculo-generico-20261023-${sha(FAKE).slice(0, 8)}.pdf`;
  const gen = (p: Project, writeFs?: Partial<SafeWriteFs>, output?: string) =>
    generateResume(request(p, 'generico', output), {
      render: stub(),
      now: fixedNow,
      ...(writeFs ? { writeFs } : {}),
    });

  it('nome previsível e destino existente nunca é sobrescrito', async () => {
    const p = makeProject(L);
    projects.push(p);
    mkdirSync(out(p), { mode: 0o700 });
    writeFileSync(join(out(p), finalName), 'original');
    const o = failed(await gen(p));
    expect(o).toMatchObject({ stage: 'gravacao', code: 'ALREADY_EXISTS' });
    expect(readFileSync(join(out(p), finalName), 'utf8')).toBe('original');
    expect(names(out(p))).toEqual([finalName]);
    rmSync(join(out(p), finalName));
    const ok = await gen(p);
    expect(ok.ok && ok.path).toBe(join(out(p), finalName));
  });

  it('corrida de publicação: outro escritor vence e nada é sobrescrito', async () => {
    const p = makeProject(L);
    projects.push(p);
    const o = failed(
      await gen(p, {
        linkSync: (a, b) => {
          writeFileSync(join(out(p), finalName), 'do outro');
          realLink(a, b);
        },
      }),
    );
    expect(o.code).toBe('ALREADY_EXISTS');
    expect(readFileSync(join(out(p), finalName), 'utf8')).toBe('do outro');
    expect(names(out(p))).toEqual([finalName]);
  });

  it('falha antes da publicação: nenhum arquivo final, mensagem diz isso', async () => {
    const p = makeProject(L);
    projects.push(p);
    const o = failed(
      await gen(p, {
        writeSync: () => {
          throw new Error('disco cheio');
        },
      }),
    );
    expect(o).toMatchObject({ stage: 'gravacao', code: 'WRITE_FAILED' });
    expect(o.message).toContain('Nenhum arquivo final foi criado');
    expect(names(out(p))).toEqual([]);
  });

  it('falha depois da publicação (limpeza): sucesso com aviso, PDF mantido', async () => {
    const p = makeProject(L);
    projects.push(p);
    const o = await gen(p, {
      unlinkSync: () => {
        throw new Error('EIO');
      },
    });
    expect(o.ok).toBe(true);
    if (!o.ok) return;
    expect(o.tempCleanup).toBe('left-behind');
    const text = formatGenerate(o);
    expect(text).toContain('Arquivo:');
    expect(text).toContain('sobrou um arquivo temporário');
    expect(text).not.toContain('Nenhum');
    expect(readFileSync(o.path).equals(FAKE)).toBe(true);
  });

  it('falha depois da publicação (fsync do diretório): sucesso sem durabilidade confirmada', async () => {
    const p = makeProject(L);
    projects.push(p);
    let calls = 0;
    const o = await gen(p, {
      fsyncSync: (fd) => {
        if (++calls === 2) throw new Error('EIO');
        realFsync(fd);
      },
    });
    expect(o).toMatchObject({ ok: true, durable: false, tempCleanup: 'removed' });
    expect(formatGenerate(o)).toContain('NÃO confirmada');
    expect(names(out(p))).toEqual([finalName]);
  });

  it('diretório com symlink ou inseguro é recusado', async () => {
    const p = makeProject(L);
    projects.push(p);
    mkdirSync(join(p.root, 'real'), { mode: 0o700 });
    symlinkSync(join(p.root, 'real'), join(p.root, 'atalho'));
    expect(failed(await gen(p, undefined, join(p.root, 'atalho'))).code).toBe('SYMLINK_REJECTED');
    mkdirSync(join(p.root, 'aberto'));
    chmodSync(join(p.root, 'aberto'), 0o777);
    expect(failed(await gen(p, undefined, join(p.root, 'aberto'))).code).toBe('OUTPUT_DIR_UNSAFE');
    expect(names(join(p.root, 'real'))).toEqual([]);
  });

  it('o nome do arquivo não é configurável pelo usuário', async () => {
    const p = makeProject(L);
    projects.push(p);
    mkdirSync(join(p.root, 'saida'), { mode: 0o700 });
    const o = await gen(p, undefined, join(p.root, 'saida', 'meu-nome.pdf'));
    expect(o.ok && o.path).toBe(join(p.root, 'saida', 'meu-nome.pdf', finalName));
  });
});

describe('cv generate: comando', () => {
  it('registra --variant, --ancora-sha256, --output e --json, sem --force', () => {
    const program = new Command();
    registerCvCommands(program);
    const generate = program.commands
      .find((c) => c.name() === 'cv')
      ?.commands.find((c) => c.name() === 'generate');
    expect(generate?.options.map((o) => o.long)).toEqual([
      '--variant',
      '--ancora-sha256',
      '--output',
      '--json',
    ]);
  });
});
