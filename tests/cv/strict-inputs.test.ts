/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/restrict-plus-operands -- JSON de registros privados sintéticos, editado de forma deliberadamente frouxa */
import { chmodSync, copyFileSync, mkdirSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { formatVariants, variantsJson } from '../../src/cli/cv-variants.js';
import { registerCvCommands } from '../../src/cli/cv-commands.js';
import { decisionHash } from '../../src/cv/decision-context.js';
import {
  CV_VARIANTS,
  StrictInputsError,
  inspectVariants,
  loadStrictInputs,
  type StrictInputsErrorCode,
} from '../../src/cv/strict-inputs.js';
import { FONT_DIR, FONT_FILES } from '../../src/cv/render/fonts.js';
import {
  addVariant,
  must,
  GENERIC,
  DEV,
  SENTINEL_DRAFT,
  SENTINEL_REJECTED,
} from '../helpers/cv-approved.js';
import { loadFictional, type Loaded } from '../helpers/cv-fixture.js';
import {
  OK_POPPLER,
  json,
  makeProject,
  sha,
  writePrivate,
  type Project,
} from '../helpers/cv-strict-project.js';

let L: Loaded;
beforeAll(async () => {
  L = await loadFictional();
});
const projects: Project[] = [];
const fresh = (prepare?: Parameters<typeof makeProject>[1]): Project => {
  const p = makeProject(L, prepare);
  projects.push(p);
  return p;
};
afterEach(() => {
  for (const p of projects.splice(0)) rmSync(p.root, { recursive: true, force: true });
});
const codeOf = (fn: () => unknown): StrictInputsErrorCode => {
  try {
    fn();
  } catch (error) {
    if (error instanceof StrictInputsError) return error.code;
    throw error;
  }
  throw new Error('não falhou');
};
const read = (path: string): unknown => JSON.parse(readFileSync(path, 'utf8')) as unknown;
/** Regrava a âncora e devolve a nova referência explícita. */
function reanchor(p: Project, edit: (anchor: Record<string, any>) => void): string {
  const anchor = read(p.paths.anchor) as Record<string, any>;
  edit(anchor);
  writePrivate(p.paths.anchor, json(anchor));
  return sha(json(anchor));
}

describe('carregador das entradas estritas', () => {
  it('carrega entradas verificadas e entrega cópias novas por variante', () => {
    const p = fresh();
    const loaded = loadStrictInputs(p.options);
    expect(loaded.manifestAreas).toEqual([null, 'desenvolvimento']);
    const generic = loaded.inputFor('generico');
    expect(generic.area).toBeUndefined();
    expect(Object.keys(generic).sort()).toEqual(
      [
        'declarations',
        'decisionContext',
        'localContext',
        'masterPdf',
        'model',
        'referenceFonts',
      ].sort(),
    );
    expect(loaded.inputFor('desenvolvimento').area).toBe('desenvolvimento');
    generic.masterPdf[0] = 0;
    expect(Buffer.compare(loaded.inputFor('generico').masterPdf, L.bytes)).toBe(0);
  });

  it('não altera nenhum arquivo privado', () => {
    const p = fresh();
    const before = Object.values(p.paths).map((f) => sha(readFileSync(f)));
    loadStrictInputs(p.options);
    inspectVariants(p.options);
    expect(Object.values(p.paths).map((f) => sha(readFileSync(f)))).toEqual(before);
  });

  it('recusa variante inexistente, não aprovada ou fora do manifesto', () => {
    const loaded = loadStrictInputs(fresh().options);
    expect(codeOf(() => loaded.inputFor('suporte'))).toBe('VARIANT_UNKNOWN');
    expect(codeOf(() => loaded.inputFor('infraestrutura'))).toBe('VARIANT_NOT_ELIGIBLE');
    expect(codeOf(() => loaded.inputFor('qa'))).toBe('VARIANT_NOT_IN_DECISIONS');
  });

  it.each(['model', 'declarations', 'anchor', 'approval', 'bundle', 'master'] as const)(
    'bloqueia arquivo ausente: %s',
    (key) => {
      const p = fresh();
      rmSync(p.paths[key]);
      const expected = {
        model: 'MODEL_MISSING',
        declarations: 'DECLARATIONS_MISSING',
        anchor: 'ANCHOR_MISSING',
        approval: 'APPROVAL_MISSING',
        bundle: 'DECISIONS_MISSING',
        master: 'MASTER_MISSING',
      }[key];
      expect(codeOf(() => loadStrictInputs(p.options))).toBe(expected);
    },
  );

  it('bloqueia arquivos corrompidos', () => {
    let p = fresh();
    writePrivate(p.paths.model, '{ não é json');
    expect(codeOf(() => loadStrictInputs(p.options))).toBe('MODEL_INVALID');
    p = fresh();
    writePrivate(p.paths.declarations, json({ schemaVersion: 2 }));
    expect(codeOf(() => loadStrictInputs(p.options))).toBe('DECLARATIONS_INVALID');
    p = fresh();
    writePrivate(p.paths.bundle, '[]');
    expect(codeOf(() => loadStrictInputs(p.options))).toBe('DECISIONS_INVALID');
    p = fresh();
    writePrivate(p.paths.approval, '{ corrompido');
    expect(codeOf(() => loadStrictInputs(p.options))).toBe('APPROVAL_INVALID');
    p = fresh();
    writePrivate(p.paths.anchor, 'corrompido');
    const options = { ...p.options, anchorSha256: sha('corrompido') };
    expect(codeOf(() => loadStrictInputs(options))).toBe('ANCHOR_INVALID');
  });

  it('exige a referência explícita da âncora e não a deriva dos arquivos', () => {
    const p = fresh();
    expect(codeOf(() => loadStrictInputs({ ...p.options, anchorSha256: undefined }))).toBe(
      'ANCHOR_REFERENCE_MISSING',
    );
    expect(codeOf(() => loadStrictInputs({ ...p.options, anchorSha256: 'abc' }))).toBe(
      'ANCHOR_REFERENCE_MISSING',
    );
    expect(codeOf(() => loadStrictInputs({ ...p.options, anchorSha256: sha('outra') }))).toBe(
      'ANCHOR_MISMATCH',
    );
  });

  it('bloqueia âncora alterada depois da referência, mesmo coerente internamente', () => {
    const p = fresh();
    reanchor(p, (a) => {
      a.trusted.manifestSha256 = sha('outro');
    });
    expect(codeOf(() => loadStrictInputs(p.options))).toBe('ANCHOR_MISMATCH');
  });

  it('bloqueia âncora divergente do manifesto (mesmo com referência atualizada)', () => {
    const p = fresh();
    const ref = reanchor(p, (a) => {
      a.trusted.manifestSha256 = sha('outro');
    });
    expect(codeOf(() => loadStrictInputs({ ...p.options, anchorSha256: ref }))).toBe(
      'DECISIONS_INVALID',
    );
  });

  it('bloqueia aprovação global divergente da âncora ou da aprovação', () => {
    let p = fresh();
    let ref = reanchor(p, (a) => {
      a.globalApproval.sha256 = sha('outra');
    });
    expect(codeOf(() => loadStrictInputs({ ...p.options, anchorSha256: ref }))).toBe(
      'APPROVAL_INVALID',
    );
    p = fresh();
    ref = reanchor(p, (a) => {
      a.globalApproval.modelHash = sha('outro');
    });
    expect(codeOf(() => loadStrictInputs({ ...p.options, anchorSha256: ref }))).toBe(
      'APPROVAL_INVALID',
    );
    p = fresh();
    const approval = read(p.paths.approval) as Record<string, any>;
    approval.scope.strictCompletionAuthorized = true;
    writePrivate(p.paths.approval, json(approval));
    ref = reanchor(p, (a) => {
      a.globalApproval.sha256 = sha(json(approval));
    });
    expect(codeOf(() => loadStrictInputs({ ...p.options, anchorSha256: ref }))).toBe(
      'APPROVAL_INVALID',
    );
  });

  it('rejeita o modelo alterado sem nova aprovação (hash aprovado obsoleto no próprio modelo)', () => {
    const p = fresh();
    const model = read(p.paths.model) as Record<string, any>;
    model.summary.variants.find((v: any) => v.id === 'resumo-geral').text += ' alterado';
    writePrivate(p.paths.model, json(model));
    expect(codeOf(() => loadStrictInputs(p.options))).toBe('MODEL_INVALID');
    expect(codeOf(() => inspectVariants(p.options))).toBe('MODEL_INVALID');
  });

  it('bloqueia aprovação obsoleta: modelo reaprovado com outro hash que a âncora não cobre', () => {
    const p = fresh();
    const model = read(p.paths.model) as Record<string, any>;
    model.summary.variants.find((v: any) => v.id === 'resumo-geral').text += ' reaprovado';
    const rehashed = fresh((m) => {
      must(m.summary.variants.find((v) => v.id === 'resumo-geral')).text += ' reaprovado';
    });
    writePrivate(p.paths.model, readFileSync(rehashed.paths.model));
    expect(codeOf(() => loadStrictInputs(p.options))).toBe('APPROVAL_STALE');
  });

  it('bloqueia decisão inválida mesmo com a âncora recalculada', () => {
    const p = fresh();
    const bundle = read(p.paths.bundle) as Record<string, any>;
    bundle.manifest.decisions.push({ id: 'decisao-falsa', declarationId: 'x' });
    writePrivate(p.paths.bundle, json(bundle));
    const ref = reanchor(p, (a) => {
      a.trusted.manifestSha256 = decisionHash(bundle.manifest);
    });
    expect(codeOf(() => loadStrictInputs({ ...p.options, anchorSha256: ref }))).toBe(
      'DECISIONS_INVALID',
    );
  });

  it('bloqueia declarações que divergem do manifesto', () => {
    const p = fresh();
    writePrivate(
      p.paths.declarations,
      json({ schemaVersion: 1, declaracoes: [{ id: 'nova', aprovada: false }] }),
    );
    expect(codeOf(() => loadStrictInputs(p.options))).toBe('DECLARATIONS_INVALID');
  });

  it('bloqueia PDF mestre com hash divergente', () => {
    const p = fresh();
    expect(
      codeOf(() =>
        loadStrictInputs({ ...p.options, masterPdf: { path: p.paths.master, sha256: sha('x') } }),
      ),
    ).toBe('MASTER_MISMATCH');
    expect(codeOf(() => loadStrictInputs({ ...p.options, masterPdf: undefined }))).toBe(
      'MASTER_MISSING',
    );
  });

  it('bloqueia fontes ausentes ou adulteradas', () => {
    const p = fresh();
    expect(
      codeOf(() => loadStrictInputs({ ...p.options, fontDir: join(p.root, 'sem-fontes') })),
    ).toBe('FONTS_INVALID');
    const dir = join(p.root, 'fontes');
    mkdirSync(dir);
    copyFileSync(join(FONT_DIR, FONT_FILES.regular), join(dir, FONT_FILES.regular));
    writePrivate(join(dir, FONT_FILES.bold), 'fonte falsa', 0o644);
    expect(codeOf(() => loadStrictInputs({ ...p.options, fontDir: dir }))).toBe('FONTS_INVALID');
  });

  it('bloqueia contexto local inválido e Poppler ausente (sem fallback)', () => {
    const p = fresh();
    expect(
      codeOf(() =>
        loadStrictInputs({
          ...p.options,
          localContext: { projectRoot: 'relativo', userName: 'usuario', hostName: 'host' },
        }),
      ),
    ).toBe('LOCAL_CONTEXT_INVALID');
    const missing = () => ({ status: null, stdout: '', stderr: '' });
    expect(codeOf(() => loadStrictInputs({ ...p.options, popplerRunner: missing }))).toBe(
      'POPPLER_MISSING',
    );
    expect(OK_POPPLER().status).toBe(0);
  });

  it('recusa arquivos privados com permissão aberta, links simbólicos e caminhos fora de data/', () => {
    let p = fresh();
    chmodSync(p.paths.model, 0o644);
    expect(codeOf(() => loadStrictInputs(p.options))).toBe('UNSAFE_FILE');
    p = fresh();
    const real = join(p.root, 'real.json');
    copyFileSync(p.paths.declarations, real);
    rmSync(p.paths.declarations);
    symlinkSync(real, p.paths.declarations);
    expect(codeOf(() => loadStrictInputs(p.options))).toBe('UNSAFE_FILE');
    p = fresh();
    const ref = reanchor(p, (a) => {
      a.bundlePath = 'config/cv-master.json';
    });
    expect(codeOf(() => loadStrictInputs({ ...p.options, anchorSha256: ref }))).toBe(
      'DECISIONS_INVALID',
    );
    const traversal = reanchor(p, (a) => {
      a.bundlePath = 'data/cv-decisions/../../config/cv-master.json';
    });
    expect(codeOf(() => loadStrictInputs({ ...p.options, anchorSha256: traversal }))).toBe(
      'DECISIONS_INVALID',
    );
    expect(tmpdir().length).toBeGreaterThan(0);
  });

  it('mensagens de erro não vazam caminhos, hashes nem conteúdo', () => {
    const p = fresh();
    rmSync(p.paths.approval);
    try {
      loadStrictInputs(p.options);
    } catch (error) {
      const message = (error as Error).message;
      expect(message).not.toContain(p.root);
      expect(message).not.toContain(p.anchorSha256);
      expect(message).not.toContain('global-teste');
    }
  });
});

describe('cv variants', () => {
  it('lista as cinco variantes com estado editorial, elegibilidade e pré-condições separados', () => {
    const p = fresh((m) => {
      addVariant(m.summary, 'resumo-infra', SENTINEL_DRAFT, 'rascunho', ['infraestrutura']);
      addVariant(m.summary, 'resumo-bd', SENTINEL_REJECTED, 'rejeitado', ['banco-de-dados']);
    });
    const list = inspectVariants(p.options);
    expect(list.map((v) => v.id)).toEqual(CV_VARIANTS.map((v) => v.id));
    const by = Object.fromEntries(list.map((v) => [v.id, v]));
    expect(by.generico).toMatchObject({ editorial: 'aprovada', selectionEligible: true });
    expect(by.desenvolvimento).toMatchObject({ editorial: 'aprovada', selectionEligible: true });
    expect(by.infraestrutura).toMatchObject({ editorial: 'rascunho', selectionEligible: false });
    expect(by['banco-de-dados']).toMatchObject({
      editorial: 'rejeitada',
      selectionEligible: false,
    });
    expect(by.generico?.preconditions).toEqual({ verified: true });
    expect(by.qa?.preconditions).toEqual({ verified: false, code: 'VARIANT_NOT_IN_DECISIONS' });
    expect(new Set(list.map((v) => v.strictValidation as string))).toEqual(new Set(['not-run']));
  });

  it('sem referência da âncora as pré-condições ficam indisponíveis, sem esconder o estado editorial', () => {
    const p = fresh();
    const list = inspectVariants({ ...p.options, anchorSha256: undefined });
    expect(list[0]).toMatchObject({ editorial: 'aprovada', selectionEligible: true });
    expect(list.every((v) => !v.preconditions.verified)).toBe(true);
  });

  it('sem modelo a listagem falha com erro tipado', () => {
    const p = fresh();
    rmSync(p.paths.model);
    expect(codeOf(() => inspectVariants(p.options))).toBe('MODEL_MISSING');
  });

  it('a saída padrão e a JSON não vazam conteúdo, caminhos nem hashes', () => {
    const p = fresh();
    const list = inspectVariants(p.options);
    const output = [formatVariants(list), JSON.stringify(variantsJson(list))].join('\n');
    for (const secret of [GENERIC, DEV, p.root, p.anchorSha256, p.model.master.sha256, 'Exemplo'])
      expect(output).not.toContain(secret);
    expect(output).not.toMatch(/[a-f0-9]{32,}/u);
    expect(output).toContain('NÃO foi executada');
  });

  it('registra o subcomando "cv variants" com --json e --ancora-sha256', () => {
    const program = new Command();
    registerCvCommands(program);
    const cv = program.commands.find((c) => c.name() === 'cv');
    const variants = cv?.commands.find((c) => c.name() === 'variants');
    expect(variants?.options.map((o) => o.long)).toEqual(['--ancora-sha256', '--json']);
  });
});
