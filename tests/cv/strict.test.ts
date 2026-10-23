import { beforeAll, afterEach, describe, expect, it, vi } from 'vitest';
import { renderAndValidateResume, type StrictResumeInput } from '../../src/cv/strict.js';
import { completionIssues } from '../../src/cv/strict-completion.js';
import { deriveForbiddenSet } from '../../src/cv/strict-context.js';
import { fontSha256 } from '../../src/cv/font-policy.js';
import { loadFonts, resolveResume, type ValidationReport } from '../../src/cv/index.js';
import * as renderer from '../../src/cv/render/pdfkit.js';
import * as validator from '../../src/cv/validate/index.js';
import * as poppler from '../../src/cv/validate/poppler.js';
import { loadFictional, type Loaded } from '../helpers/cv-fixture.js';
import { approvedModel, reapprove, must } from '../helpers/cv-approved.js';
import { mutateTtf } from '../helpers/cv-fonts.js';

vi.setConfig({ testTimeout: 30_000 });
let L: Loaded;
let base: StrictResumeInput;
let diagnostic: ValidationReport;
const render = renderer.renderResume;
const validate = validator.validateRenderedPdf;
const runner = poppler.defaultRunner;
beforeAll(async () => {
  L = await loadFictional();
  const f = loadFonts();
  base = {
    model: approvedModel(L),
    masterPdf: L.bytes,
    declarations: { schemaVersion: 1, declaracoes: [] },
    referenceFonts: [
      { name: 'Lato-Regular', bytes: f.regular },
      { name: 'Lato-Bold', bytes: f.bold },
    ],
    localContext: {
      projectRoot: '/projeto/ficticio',
      userName: 'usuario-ficticio',
      hostName: 'host-ficticio',
    },
  };
  const result = await renderAndValidateResume(base);
  expect(result.report.issues).toEqual([]);
  if (result.report.diagnostic === null) throw new Error('sem diagnóstico');
  diagnostic = result.report.diagnostic;
});
afterEach(() => vi.restoreAllMocks());
const input = () => structuredClone(base);
const expected = () => ({ pdfSha256: diagnostic.pdfSha256, pages: diagnostic.pages ?? 0 });

const mutations: [string, (r: ValidationReport) => void][] = [
  [
    'ok falso',
    (r) => {
      r.ok = false;
    },
  ],
  [
    'complete diagnóstico forjado',
    (r) => {
      Object.assign(r, { complete: true });
    },
  ],
  [
    'check ausente',
    (r) => {
      r.checks.pop();
    },
  ],
  [
    'check repetido',
    (r) => {
      r.checks[1] = structuredClone(must(r.checks[0]));
    },
  ],
  [
    'check extra',
    (r) => {
      r.checks.push(structuredClone(must(r.checks[0])));
    },
  ],
  [
    'implemented incompleto',
    (r) => {
      r.implemented.pop();
    },
  ],
  [
    'pendência',
    (r) => {
      r.pending.push('não comprovado');
    },
  ],
  [
    'sem ForbiddenSet',
    (r) => {
      r.forbiddenProvided = false;
    },
  ],
  [
    'hash divergente',
    (r) => {
      r.pdfSha256 = '0'.repeat(64);
    },
  ],
  [
    'páginas divergentes',
    (r) => {
      r.pages = 2;
    },
  ],
  [
    'Poppler ausente',
    (r) => {
      r.extractors.pop();
    },
  ],
  [
    'extrator repetido',
    (r) => {
      r.extractors[1] = structuredClone(must(r.extractors[0]));
    },
  ],
  [
    'sem versão',
    (r) => {
      delete must(r.extractors[0]).version;
    },
  ],
  [
    'identidade parcial',
    (r) => {
      r.fontIdentity.status = 'partial';
    },
  ],
  [
    'identidade sem fontes',
    (r) => {
      r.fontIdentity.fonts = [];
    },
  ],
  [
    'identidade pendente',
    (r) => {
      r.fontIdentity.pending.push('composto');
    },
  ],
  [
    'fonte não comprovada',
    (r) => {
      must(r.fontIdentity.fonts[0]).verified = false;
    },
  ],
  [
    'tabelas diferentes',
    (r) => {
      must(r.fontIdentity.fonts[0]).tablesIdentical = false;
    },
  ],
  [
    'ambiguidade',
    (r) => {
      must(r.fontIdentity.fonts[0]).ambiguous = 1;
    },
  ],
  [
    'pendência por fonte',
    (r) => {
      must(r.fontIdentity.fonts[0]).pending.push('Unicode');
    },
  ],
  [
    'glifo não comprovado',
    (r) => {
      must(r.fontIdentity.fonts[0]).simpleMatched--;
    },
  ],
  [
    'composto não comprovado',
    (r) => {
      must(r.fontIdentity.fonts[0]).compositeMatched--;
    },
  ],
  [
    'vazio não comprovado',
    (r) => {
      must(r.fontIdentity.fonts[0]).emptyMatched--;
    },
  ],
  [
    'variante inválida',
    (r) => {
      must(r.fontIdentity.fonts[0]).variant = null;
    },
  ],
  [
    'contagem inválida',
    (r) => {
      must(r.fontIdentity.fonts[0]).unicodeMatched = NaN;
    },
  ],
];
for (const id of ['H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'H7', 'H8', 'H9', 'H10'])
  for (const status of ['fail', 'skipped'] as const)
    mutations.push([
      `${id} ${status}`,
      (r) => {
        const check = r.checks.find((c) => c.id === id);
        if (check === undefined) throw new Error('sem check');
        check.status = status;
      },
    ]);
for (const name of ['pdfjs-dist', 'poppler (pdftotext)'])
  for (const status of ['skipped', 'missing', 'error'] as const)
    mutations.push([
      `${name} ${status}`,
      (r) => {
        const e = r.extractors.find((x) => x.name === name);
        if (e === undefined) throw new Error('sem extrator');
        e.status = status;
      },
    ]);

describe('conclusão estrita: todas as condições são obrigatórias', () => {
  it('diagnóstico integral ainda tem complete=false e apenas satisfaz as guardas', () => {
    expect(diagnostic.complete).toBe(false);
    expect(completionIssues(diagnostic, expected())).toEqual([]);
  });
  it.each(mutations)('%s impede conclusão', (_, mutate) => {
    const report = structuredClone(diagnostic);
    mutate(report);
    expect(completionIssues(report, expected()).length).toBeGreaterThan(0);
  });
});

describe('integração estrita somente em memória', () => {
  it('conclui, vincula hashes e protege o artefato e o relatório devolvidos', async () => {
    const result = await renderAndValidateResume(input());
    expect(result.report.ok).toBe(true);
    expect(result.report.complete).toBe(true);
    expect(result.report.fontIdentity.status).toBe('verified');
    expect(result.report.referenceIntegrity).toBe('verified');
    expect(result.report.diagnostic?.complete).toBe(false);
    expect(result.report.bindings?.resolvedSha256).toBe(
      resolveResume(approvedModel(L), { extraction: L.extraction }).manifest.contentSha256,
    );
    const bytes = result.artifact?.readBytes();
    if (bytes === undefined) throw new Error('sem PDF');
    expect(fontSha256(bytes)).toBe(result.report.bindings?.pdfSha256);
    bytes.fill(0);
    expect(fontSha256(must(result.artifact).readBytes())).toBe(result.artifact?.pdfSha256);
    expect(() => {
      result.report.complete = false;
    }).toThrow();
  });
  it('mesmas entradas geram mesmos bytes, hashes e relatório', async () => {
    const a = await renderAndValidateResume(input());
    const b = await renderAndValidateResume(input());
    expect(a.report).toEqual(b.report);
    expect(a.artifact?.readBytes()).toEqual(b.artifact?.readBytes());
  });
  it.each(['referenceFonts', 'masterPdf', 'declarations', 'localContext'] as const)(
    'entrada %s ausente bloqueia',
    async (key) => {
      const data = input();
      Reflect.deleteProperty(data, key);
      const result = await renderAndValidateResume(data);
      expect(result.report.complete).toBe(false);
      expect(result.report.ok).toBe(false);
      expect(result.artifact).toBeUndefined();
    },
  );
  it.each([
    'complete',
    'ok',
    'forbidden',
    'poppler',
    'popplerRunner',
    'expectedHash',
    'layout',
  ] as const)('não aceita atalho %s do chamador', async (key) => {
    const result = await renderAndValidateResume(Object.assign(input(), { [key]: true }));
    expect(result.report.issues).toContain('INPUT');
    expect(result.report.complete).toBe(false);
  });
  it('modelo sem aprovação e aprovação obsoleta são recusados', async () => {
    const data = input();
    const model = approvedModel(L);
    delete model.approval;
    data.model = model;
    expect((await renderAndValidateResume(data)).report.issues).toContain('RESOLUTION');
    data.model = approvedModel(L);
    must((data.model as ReturnType<typeof approvedModel>).summary.variants[0]).text += ' alterado';
    expect((await renderAndValidateResume(data)).report.issues).toContain('MODEL');
  });
  it('mestre substituído falha antes da extração', async () => {
    const data = input();
    data.masterPdf.fill(0);
    expect((await renderAndValidateResume(data)).report.issues).toContain('MASTER');
  });
  it('área sem variante utilizável não usa fallback', async () => {
    const result = await renderAndValidateResume({ ...input(), area: 'suporte' });
    expect(result.report.issues).toContain('RESOLUTION');
  });
  it('não considera um contexto local vazio suficiente', async () => {
    const data = input();
    data.localContext.hostName = '';
    expect((await renderAndValidateResume(data)).report.issues).toContain('LOCAL_CONTEXT');
  });
  it('contexto retido insuficiente não vira ForbiddenSet vazio', async () => {
    const data = input();
    const model = approvedModel(L);
    must(model.certifications[0]).description = 'IA';
    data.model = reapprove(model);
    expect((await renderAndValidateResume(data)).report.issues).toContain('FORBIDDEN_CONTEXT');
  });
  it('deriva variantes não aprovadas, links e campos retidos sem parâmetros externos', () => {
    const set = deriveForbiddenSet(approvedModel(L));
    expect(set.phrases.some((s) => s.includes('TEXTO-EM-RASCUNHO'))).toBe(true);
    expect(set.urls).toContain(
      approvedModel(L).identity.links.find((l) => !l.confirmedByUser)?.url,
    );
    expect(set.retained.map((r) => r.label).join(' ')).toMatch(/ano/);
    expect(set.retained.map((r) => r.label).join(' ')).toMatch(/descrição/);
  });
  it('snapshot não é alterado por mutações externas após a chamada', async () => {
    const data = input();
    const pending = renderAndValidateResume(data);
    must(data.referenceFonts[0]).bytes.fill(0);
    data.masterPdf.fill(0);
    must((data.model as ReturnType<typeof approvedModel>).summary.variants[0]).text = 'substituído';
    (data.declarations as { declaracoes: unknown[] }).declaracoes.push({ id: 'injetado' });
    data.localContext.hostName = '';
    const result = await pending;
    expect(result.report.complete).toBe(true);
    expect(result.report.bindings?.pdfSha256).toBe(diagnostic.pdfSha256);
  });
  it('buffers de fontes alterados dentro da renderização não são reutilizados como autenticados', async () => {
    vi.spyOn(renderer, 'renderResume').mockImplementation(async (resume, options) => {
      const result = await render(resume, options);
      options?.fonts?.regular.fill(0);
      return result;
    });
    const result = await renderAndValidateResume(input());
    expect(result.report.issues).toContain('REFERENCES');
    expect(result.artifact).toBeUndefined();
  });
  it('conteúdo trocado e hash do manifesto falsificado não passam', async () => {
    vi.spyOn(renderer, 'renderResume').mockImplementation(async (resume, options) => {
      const changed = structuredClone(resume);
      changed.summary = 'Conteúdo substituído e não aprovado.';
      return render(changed, options);
    });
    const result = await renderAndValidateResume(input());
    expect(result.report.complete).toBe(false);
    expect(result.report.diagnostic?.checks.find((c) => c.id === 'H2')?.status).toBe('fail');
  });
  it.each(['hash', 'source', 'pages', 'fit'] as const)(
    'metadado do artefato %s divergente bloqueia',
    async (field) => {
      vi.spyOn(renderer, 'renderResume').mockImplementation(async (resume, options) => {
        const result = await render(resume, options);
        if (field === 'hash') result.pdfSha256 = '0'.repeat(64);
        if (field === 'source') result.sourceContentSha256 = '0'.repeat(64);
        if (field === 'pages') result.pages = 99;
        if (field === 'fit') result.fit.stepIndex = 999;
        return result;
      });
      expect((await renderAndValidateResume(input())).report.issues).toContain('BINDINGS');
    },
  );
  it('PDF e referência adulterados conjuntamente não passam pelo hash fixado', async () => {
    const data = input();
    const regular = mutateTtf(Buffer.from(must(data.referenceFonts[0]).bytes), (parts) => {
      const fpgm = parts.tables.get('fpgm');
      if (fpgm === undefined) throw new Error('sem fpgm');
      fpgm[0] = (fpgm[0] ?? 0) ^ 1;
    });
    const resolved = resolveResume(approvedModel(L), { extraction: L.extraction });
    const f = loadFonts();
    const pdf = await render(resolved, { fonts: { regular, bold: f.bold } });
    const diagnosticOnly = await validate(pdf.bytes, resolved, {
      poppler: 'require',
      referenceFonts: [
        { name: 'Lato-Regular', bytes: regular },
        { name: 'Lato-Bold', bytes: f.bold },
      ],
    });
    expect(diagnosticOnly.fontIdentity.status).toBe('verified');
    expect(diagnosticOnly.complete).toBe(false);
    data.referenceFonts = [
      { name: 'Lato-Regular', bytes: regular },
      { name: 'Lato-Bold', bytes: f.bold },
    ];
    const result = await renderAndValidateResume(data);
    expect(result.report.issues).toContain('REFERENCES');
    expect(result.report.complete).toBe(false);
  });
  it.each(['bytes', 'expectation', 'forbidden', 'fonts'] as const)(
    'mutação em %s durante a validação é detectada',
    async (target) => {
      vi.spyOn(validator, 'validateRenderedPdf').mockImplementation(
        async (bytes, resume, options) => {
          const report = await validate(bytes, resume, options);
          if (target === 'bytes') bytes.fill(0);
          if (target === 'expectation') resume.summary = 'alterado';
          if (target === 'forbidden') options?.forbidden?.phrases.splice(0);
          if (target === 'fonts') options?.referenceFonts?.[0]?.bytes.fill(0);
          return report;
        },
      );
      const result = await renderAndValidateResume(input());
      expect(result.report.complete).toBe(false);
      expect(result.artifact).toBeUndefined();
      expect(result.report.issues).toContain(target === 'fonts' ? 'REFERENCES' : 'BINDINGS');
    },
  );
  it.each(['pdftotext', 'pdffonts'] as const)('%s ausente falha sem fallback', async (command) => {
    vi.spyOn(poppler, 'defaultRunner').mockImplementation((cmd, args, bytes) =>
      cmd === command ? { status: null, stdout: '', stderr: '' } : runner(cmd, args, bytes),
    );
    const result = await renderAndValidateResume(input());
    expect(result.report.complete).toBe(false);
    expect(result.report.ok).toBe(false);
  });
  it('divergência do Poppler não é ignorada', async () => {
    vi.spyOn(poppler, 'defaultRunner').mockImplementation((cmd, args, bytes) =>
      cmd === 'pdftotext' && !args.includes('-v')
        ? { status: 0, stdout: 'Texto adulterado.', stderr: '' }
        : runner(cmd, args, bytes),
    );
    const result = await renderAndValidateResume(input());
    expect(result.report.complete).toBe(false);
    expect(result.report.diagnostic?.checks.find((c) => c.id === 'H2')?.status).toBe('fail');
  });
  it('erro inesperado não é mascarado por sucesso nem reprovação genérica', async () => {
    vi.spyOn(renderer, 'renderResume').mockRejectedValue(new Error('erro interno de teste'));
    await expect(renderAndValidateResume(input())).rejects.toThrow('erro interno de teste');
  });
  it('declaração referenciada ausente e identificadores repetidos bloqueiam', async () => {
    const data = input();
    const model = approvedModel(L);
    must(model.summary.variants.find((v) => v.id === 'resumo-geral')).basis = [
      {
        kind: 'declaracao_proprietario',
        ref: 'data/cv-declarations.json#decl-teste',
        note: 'origem fictícia',
      },
    ];
    data.model = reapprove(model);
    expect((await renderAndValidateResume(data)).report.issues).toContain('DECLARATIONS');
    data.declarations = {
      schemaVersion: 1,
      declaracoes: [
        { id: 'decl-teste', aprovada: true },
        { id: 'decl-teste', aprovada: true },
      ],
    };
    expect((await renderAndValidateResume(data)).report.issues).toContain('DECLARATIONS');
  });
  it('declaração referenciada ainda não aprovada bloqueia sem modificar seu registro', async () => {
    const data = input();
    const model = approvedModel(L);
    must(model.summary.variants.find((v) => v.id === 'resumo-geral')).basis = [
      {
        kind: 'declaracao_proprietario',
        ref: 'data/cv-declarations.json#decl-teste',
        note: 'origem fictícia',
      },
    ];
    data.model = reapprove(model);
    data.declarations = { schemaVersion: 1, declaracoes: [{ id: 'decl-teste', aprovada: false }] };
    const before = structuredClone(data);
    const result = await renderAndValidateResume(data);
    expect(result.report.issues).toContain('DECLARATIONS');
    expect(result.report.complete).toBe(false);
    expect(data).toEqual(before);
  });
  it('troca do ForbiddenSet por um conjunto vazio dentro do validador é detectada', async () => {
    vi.spyOn(validator, 'validateRenderedPdf').mockImplementation(
      async (bytes, resume, options) => {
        if (options === undefined) throw new Error('sem opções');
        options.forbidden = { phrases: [], urls: [], retained: [] };
        return validate(bytes, resume, options);
      },
    );
    const result = await renderAndValidateResume(input());
    expect(result.report.complete).toBe(false);
    expect(result.report.issues).toContain('BINDINGS');
  });
  it('o renderizador copia os bytes fornecidos antes de suspender a execução', async () => {
    const resolved = resolveResume(approvedModel(L), { extraction: L.extraction });
    const f = loadFonts();
    const supplied = { regular: Buffer.from(f.regular), bold: Buffer.from(f.bold) };
    const pending = render(resolved, { fonts: supplied });
    supplied.regular.fill(0);
    supplied.bold.fill(0);
    const artifact = await pending;
    expect(artifact.pdfSha256).toBe((await render(resolved)).pdfSha256);
  });
});
