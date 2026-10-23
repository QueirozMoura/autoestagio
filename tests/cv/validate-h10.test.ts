import { beforeAll, describe, expect, it, vi } from 'vitest';
import {
  loadFonts,
  renderResume,
  validateRenderedPdf,
  type CheckId,
  type ResolvedResume,
  type ValidateOptions,
  type ValidationReport,
} from '../../src/cv/index.js';
import { checkDangerous, withoutSpaces } from '../../src/cv/validate/dangerous.js';
import { extractForValidation, type ExtractedPdf } from '../../src/cv/validate/index.js';
import {
  isDict,
  isRef,
  readPdfStructure,
  type PdfValue,
} from '../../src/cv/validate/pdf-objects.js';
import {
  TINY_PNG,
  buildPdf,
  craftLatoPdf,
  craftPdf,
  minimalBodies,
  tamperSameLength,
} from '../helpers/cv-pdf-tamper.js';
import { fictionalResume } from '../helpers/cv-resume.js';

// Renderizar e validar PDFs é mais lento com a suíte inteira rodando em paralelo.
vi.setConfig({ testTimeout: 30_000 });

const OFF: ValidateOptions = { poppler: 'off' };
const check = (report: ValidationReport, id: CheckId) => {
  const found = report.checks.find((c) => c.id === id);
  if (found === undefined) throw new Error(`sem ${id}`);
  return found;
};
const h10 = async (
  bytes: Buffer,
  resume: ResolvedResume,
  options: ValidateOptions = OFF,
): Promise<string> => {
  const report = await validateRenderedPdf(bytes, resume, options);
  return check(report, 'H10').status === 'pass' ? 'PASS' : check(report, 'H10').details.join('\n');
};

let resume: ResolvedResume;
let bytes: Buffer;
let fonts: ReturnType<typeof loadFonts>;
beforeAll(async () => {
  resume = fictionalResume();
  bytes = (await renderResume(resume)).bytes;
  fonts = loadFonts();
});

/** `ExtractedPdf` mínimo e limpo, para chamar o H10 direto com estruturas sintéticas. */
const cleanExtracted = (): ExtractedPdf => ({
  pages: 1,
  extractor: { name: 'fake', version: '0' },
  runs: [],
  streamText: '',
  geometryText: '',
  annotations: [],
  runsPerPage: [0],
  pageLines: [],
  pageViews: [],
  info: {},
  security: {
    jsActions: false,
    attachments: false,
    formFields: false,
    xfa: false,
    nonLinkAnnotations: [],
    annotationsWithActions: 0,
  },
});
const dangerousOn = (
  bodies: (string | Buffer)[],
  extracted = cleanExtracted(),
  options?: { trailerExtra?: string },
) =>
  checkDangerous({
    structure: readPdfStructure(buildPdf(bodies, options)),
    structureError: undefined,
    extracted,
  });

describe('H10: PDFs válidos do renderizador passam', () => {
  it('uma e duas páginas, com e sem Poppler, sem falsos positivos', async () => {
    for (const options of [OFF, {}] as ValidateOptions[]) {
      expect(await h10(bytes, resume, options)).toBe('PASS');
      const bigger = fictionalResume({ extraBullets: 2, extraEntries: 2 });
      expect(await h10((await renderResume(bigger)).bytes, bigger, options)).toBe('PASS');
    }
  });

  it('o resumo diz o que foi conferido', async () => {
    const report = await validateRenderedPdf(bytes, resume, OFF);
    expect(check(report, 'H10').summary).toMatch(/objetos, todos em caminhos permitidos/);
    expect(report.implemented).toContain('H10');
    expect(report.pending).toEqual(['H6', 'H7']);
    expect(report.complete).toBe(false);
  });

  it('o único objeto sem referência do PDFKit é um dicionário vazio (a exceção específica)', () => {
    const s = readPdfStructure(bytes);
    const reached = new Set<number>();
    const visit = (value: PdfValue | undefined): void => {
      if (isRef(value)) {
        if (reached.has(value.num)) return;
        reached.add(value.num);
        visit(s.objects.get(value.num)?.value);
      } else if (Array.isArray(value)) value.forEach(visit);
      else if (isDict(value)) for (const v of value.map.values()) visit(v);
    };
    visit(s.trailer.map.get('Root'));
    visit(s.trailer.map.get('Info'));
    const orphans = [...s.objects.values()].filter((o) => !reached.has(o.num));
    expect(orphans).toHaveLength(1);
    expect(
      isDict(orphans[0]?.value) &&
        orphans[0].value.map.size === 0 &&
        orphans[0].stream === undefined,
    ).toBe(true);
  });

  it('o texto dos operadores só difere do pdfjs em espaços (e isso é tudo que se ignora)', () => {
    expect(withoutSpaces('Stack  |  2025')).toBe(withoutSpaces('Stack| 2025'));
    expect(withoutSpaces('a b')).not.toBe(withoutSpaces('a c'));
    expect(withoutSpaces('e-commerce')).not.toBe(withoutSpaces('ecommerce'));
    expect(withoutSpaces('A1')).not.toBe(withoutSpaces('A2'));
    expect(withoutSpaces('Ab')).not.toBe(withoutSpaces('ab'));
    expect(withoutSpaces('a b')).not.toBe(withoutSpaces('ab')); // NBSP não é "espaço comum"
  });
});

describe('H10: elementos perigosos montados com o PDFKit', () => {
  it('JavaScript nomeado', async () => {
    const pdf = await craftLatoPdf((p) => {
      p.text('Texto qualquer', 46, 100);
      p.addNamedJavaScript('boom', 'app.alert(1)');
    }, fonts);
    expect(await h10(pdf, resume)).toMatch(/elemento perigoso \/(JavaScript|JS)/);
  });

  it('arquivo anexado', async () => {
    const pdf = await craftLatoPdf((p) => {
      p.text('Texto qualquer', 46, 100);
      p.file(Buffer.from('conteúdo escondido'), { name: 'segredo.txt' });
    }, fonts);
    const report = await h10(pdf, resume);
    expect(report).toMatch(/elemento perigoso \/(EmbeddedFile|EF|Filespec|EmbeddedFiles)/);
  });

  it('campo de formulário', async () => {
    const pdf = await craftLatoPdf((p) => {
      p.initForm();
      p.formText('campo', 46, 100, 200, 20);
    }, fonts);
    expect(await h10(pdf, resume)).toMatch(
      /elemento perigoso \/AcroForm|o pdfjs encontrou campos de formulário/,
    );
  });

  it('imagem (XObject)', async () => {
    const pdf = await craftLatoPdf((p) => {
      p.text('Texto qualquer', 46, 100);
      p.image(TINY_PNG, 46, 200, { width: 20 });
    }, fonts);
    const report = await h10(pdf, resume);
    expect(report).toMatch(/\/Image|XObject/);
  });

  it('ação de ir-para (GoTo) em vez de URI', async () => {
    const pdf = await craftLatoPdf((p) => {
      p.text('Clique aqui', 46, 100);
      p.goTo(46, 98, 80, 14, 'destino');
    }, fonts);
    const report = await h10(pdf, resume);
    expect(report).toMatch(/anotação|ação/);
  });
});

describe('H10: adulterações da estrutura (bytes de mesmo tamanho)', () => {
  it.each([
    [
      'AA no catálogo',
      () => tamperSameLength(bytes, '/Lang (pt-BR)', '/AA <<>>     '),
      /elemento perigoso \/AA/,
    ],
    [
      'OpenAction no catálogo',
      () => tamperSameLength(bytes, '/Lang (pt-BR)', '/OpenAction 1'),
      /elemento perigoso \/OpenAction/,
    ],
    [
      'chave desconhecida no catálogo',
      () => tamperSameLength(bytes, '/Lang (pt-BR)', '/Foo (pt-BR) '),
      /chave não permitida em catálogo.*\/Foo/,
    ],
    [
      'chave desconhecida na página',
      () => tamperSameLength(bytes, '/Tabs /S', '/Fooo /S'),
      /chave não permitida em página.*\/Fooo/,
    ],
    [
      'recurso não permitido (/Properties)',
      () => tamperSameLength(bytes, '/ColorSpace', '/Properties'),
      /chave não permitida em recursos da página.*\/Properties/,
    ],
    [
      'anotação que não é Link',
      () => tamperSameLength(bytes, '/Subtype /Link', '/Subtype /Text', 0),
      /deveria ser \/Link/,
    ],
    [
      'ação que não é URI',
      () => tamperSameLength(bytes, '/S /URI', '/S /JS '),
      /ação.*deveria ser \/URI/,
    ],
    [
      'tipo de elemento de estrutura não permitido',
      () => tamperSameLength(bytes, '/S /H1', '/S /H9'),
      /tipo \/H9 não permitido/,
    ],
    [
      'chave extra no Info',
      () => tamperSameLength(bytes, '/ModDate ', '/Trapped '),
      /chave não permitida em Info.*\/Trapped/,
    ],
    [
      'codificação diferente de Identity-H',
      () => tamperSameLength(bytes, '/Encoding /Identity-H', '/Encoding /Identity-V'),
      /deveria ser \/Identity-H/,
    ],
    [
      'chave extra no fluxo (ToUnicode sem /Filter)',
      () => tamperSameLength(bytes, '/Filter /FlateDecode', '/Filtex /FlateDecode', 1),
      /fluxo de .*chave não permitida|chave não permitida em fluxo/,
    ],
  ])('%s', async (_name, make, message) => {
    const report = await h10(make(), resume);
    expect(report).toMatch(message);
  });

  it('um objeto que perdeu sua referência vira órfão (o fluxo de conteúdo trocado por outro objeto)', async () => {
    const raw = bytes.toString('latin1');
    const contents = /\/Contents (\d+) 0 R/.exec(raw);
    if (contents === null) throw new Error('sem /Contents');
    const target = Number(contents[1]);
    const other = String(target - 1).padStart(String(target).length, '0');
    const tampered = tamperSameLength(bytes, `/Contents ${target} 0 R`, `/Contents ${other} 0 R`);
    const report = await h10(tampered, resume);
    expect(report).toMatch(
      new RegExp(`objeto ${target} fora de qualquer caminho permitido.*fluxo`),
    );
  });
});

describe('H10: conteúdo escondido, nos operadores', () => {
  const place = (x: number, y: number) => (p: PDFKit.PDFDocument) => {
    p.fontSize(10).text('TEXTO ESCONDIDO FORA DA PÁGINA', x, y, { lineBreak: false });
  };

  it('controle: um PDF montado com texto normal passa pela análise de conteúdo', async () => {
    const ok = await craftLatoPdf((p) => {
      p.fontSize(10).text('Texto normal e visível', 46, 100, { lineBreak: false });
    }, fonts);
    expect(await h10(ok, resume)).toBe('PASS');
  });

  it.each([
    ['à direita', place(900, 100)],
    ['abaixo', place(100, 900)],
    ['acima', place(100, -80)],
    ['à esquerda', place(-600, 100)],
  ])(
    'texto totalmente fora da página, %s: invisível para o pdfjs, pego pelos operadores',
    async (_name, draw) => {
      const pdf = await craftLatoPdf((p) => {
        p.fontSize(10).text('Texto visível', 46, 60, { lineBreak: false });
        draw(p);
      }, fonts);
      // O pdfjs e o Poppler não enxergam o texto de fora da página...
      expect((await extractForValidation(pdf)).streamText).not.toContain('ESCONDIDO');
      // ...mas o intérprete dos operadores o encontra.
      const report = await h10(pdf, resume);
      expect(report).toMatch(/totalmente fora da página/);
      expect(report).toMatch(/o texto dos operadores difere do texto extraído pelo pdfjs/);
    },
  );

  it('texto branco e quase branco', async () => {
    for (const color of ['#ffffff', '#fafafa']) {
      const pdf = await craftLatoPdf((p) => {
        p.fillColor(color)
          .fontSize(10)
          .text('Palavras-chave invisíveis para quem lê', 46, 100, { lineBreak: false });
      }, fonts);
      expect(await h10(pdf, resume), color).toMatch(/texto branco ou quase branco/);
    }
  });

  it('tamanho de fonte indevido (minúsculo e gigante)', async () => {
    const tiny = await craftLatoPdf((p) => {
      p.fontSize(2).text('texto microscópico', 46, 100, { lineBreak: false });
    }, fonts);
    expect(await h10(tiny, resume)).toMatch(/tamanho de fonte indevido.*2\.00 pt/);
    const huge = await craftLatoPdf((p) => {
      p.fontSize(70).text('GIGANTE', 46, 100, { lineBreak: false });
    }, fonts);
    expect(await h10(huge, resume)).toMatch(/tamanho de fonte indevido.*70\.00 pt/);
  });

  it('texto invisível (modo de renderização 3 Tr) e demais operadores fora da lista', async () => {
    const invisible = await craftLatoPdf((p) => {
      p.fontSize(10).text('Texto normal', 46, 60, { lineBreak: false });
      p.addContent('3 Tr');
    }, fonts);
    expect(await h10(invisible, resume)).toMatch(/"Tr" não está na lista de permissão/);

    for (const [op, content] of [
      ['Do', '/Im1 Do'],
      ['gs', '/GS0 gs'],
      ['re', '0 0 595 842 re'],
      ['f', 'f'],
      ['sh', '/Sh0 sh'],
      ['BI', 'BI /W 1 /H 1 /BPC 8 /CS /G ID x EI'],
    ] as const) {
      const pdf = await craftLatoPdf((p) => {
        p.fontSize(10).text('Texto normal', 46, 60, { lineBreak: false });
        p.addContent(content);
      }, fonts);
      expect(await h10(pdf, resume), op).toMatch(new RegExp(`"${op}"`));
    }
  });

  it('operadores desequilibrados (q, BT e BDC abertos)', async () => {
    const pdf = await craftLatoPdf((p) => {
      p.fontSize(10).text('Texto normal', 46, 60, { lineBreak: false });
      p.addContent('q\nBT\n/P << /MCID 99 >> BDC');
    }, fonts);
    const report = await h10(pdf, resume);
    expect(report).toMatch(/"BT" sem "ET"/);
    expect(report).toMatch(/"q" sem "Q"/);
    expect(report).toMatch(/"BDC" sem "EMC"/);
  });

  it('texto desenhado por operadores com glifo sem ToUnicode', async () => {
    // O texto padrão do PDFKit (Helvetica, fonte simples) não é Identity-H: é recusado pelo intérprete.
    const simple = await craftPdf((p) => {
      p.fontSize(10).text('Fonte padrão', 46, 100, { lineBreak: false });
    });
    expect(await h10(simple, resume)).toMatch(/só Identity-H é suportada|fonte|Encoding/);
  });
});

describe('H10: exceções específicas e falha fechada', () => {
  it('base mínima permitida passa (controle das variações abaixo)', () => {
    expect(dangerousOn(minimalBodies()).status).toBe('pass');
  });

  it('órfão: só o dicionário VAZIO é aceito; qualquer outra coisa reprova', () => {
    expect(dangerousOn(minimalBodies({ extra: ['<< >>'] })).status).toBe('pass');
    const cases: [string, string | Buffer, RegExp][] = [
      ['dicionário com chave', '<< /A 1 >>', /dicionário \{A\}/],
      ['texto', '(segredo)', /texto "segredo"/],
      ['lista', '[1 2 3]', /lista/],
      ['número', '42', /valor/],
      ['fluxo', '<< /Length 3 >>\nstream\nabc\nendstream', /fluxo/],
      ['dicionário vazio COM fluxo', '<< >>\nstream\nabc\nendstream', /fluxo/],
    ];
    for (const [name, body, message] of cases) {
      const check = dangerousOn(minimalBodies({ extra: [body] }));
      expect(check.status, name).toBe('fail');
      expect(check.details.join('\n'), name).toMatch(message);
      expect(check.details.join('\n'), name).toMatch(/fora de qualquer caminho permitido/);
    }
  });

  it('/Names: só a árvore /Dests vazia do PDFKit', () => {
    const names = (body: string) =>
      dangerousOn(minimalBodies({ catalogExtra: '/Names 5 0 R', extra: [body] }));
    expect(names('<< /Dests << /Names [ ] >> >>').status).toBe('pass');
    expect(names('<< /Dests << /Names [ (a) 1 ] >> >>').details.join()).toMatch(
      /\/Names do catálogo não é a árvore \/Dests vazia/,
    );
    expect(
      names('<< /Dests << /Names [ ] >> /JavaScript << /Names [ ] >> >>').details.join(),
    ).toMatch(/\/JavaScript|chave não permitida em \/Names/);
    expect(names('<< /EmbeddedFiles << /Names [ ] >> >>').details.join()).toMatch(/EmbeddedFiles/);
  });

  it('/length minúsculo: só no fluxo XMP (exceção do PDFKit); em outro fluxo reprova', () => {
    const xmp = (extra: string) =>
      dangerousOn(
        minimalBodies({
          catalogExtra: '/Metadata 5 0 R',
          extra: [`<< /Type /Metadata /Subtype /XML /Length 3 ${extra} >>\nstream\nabc\nendstream`],
        }),
      );
    expect(xmp('/length 3').status).toBe('pass');
    expect(xmp('/foo 3').details.join()).toMatch(/chave não permitida em fluxo de XMP.*\/foo/);
    const content = dangerousOn(
      minimalBodies({ content: 'q Q' }).map((b, i) =>
        i === 3 ? '<< /Length 3 /length 3 >>\nstream\nq Q\nendstream' : b,
      ),
    );
    expect(content.details.join()).toMatch(/chave não permitida em fluxo de conteúdo.*\/length/);
  });

  it('referência para objeto inexistente e filtro não permitido', () => {
    expect(dangerousOn(minimalBodies({ catalogExtra: '/Metadata 99 0 R' })).details.join()).toMatch(
      /objeto inexistente 99/,
    );
    const lzw = dangerousOn(
      minimalBodies().map((b, i) =>
        i === 3 ? '<< /Length 3 /Filter /LZWDecode >>\nstream\nq Q\nendstream' : b,
      ),
    );
    expect(lzw.details.join()).toMatch(/filtro não permitido: \/LZWDecode/);
  });

  it('o pdfjs como segunda opinião reprova mesmo com a estrutura limpa', () => {
    const bad = (security: Partial<ExtractedPdf['security']>) =>
      dangerousOn(minimalBodies(), {
        ...cleanExtracted(),
        security: { ...cleanExtracted().security, ...security },
      }).details.join();
    expect(bad({ jsActions: true })).toMatch(/ações JavaScript/);
    expect(bad({ attachments: true })).toMatch(/arquivos anexados/);
    expect(bad({ formFields: true })).toMatch(/campos de formulário/);
    expect(bad({ xfa: true })).toMatch(/XFA/);
    expect(bad({ nonLinkAnnotations: ['Widget', 'FileAttachment'] })).toMatch(
      /Widget, FileAttachment/,
    );
    expect(bad({ annotationsWithActions: 2 })).toMatch(/2 anotação\(ões\) com ação/);
  });

  it('estrutura ilegível ou acima dos limites: falha fechada em H10 (os demais checks seguem)', async () => {
    const report = await validateRenderedPdf(bytes, resume, {
      ...OFF,
      structureLimits: { maxObjects: 10 },
    });
    expect(check(report, 'H10').status).toBe('fail');
    expect(check(report, 'H10').details.join()).toMatch(/TOO_MANY_OBJECTS/);
    for (const id of ['H1', 'H2', 'H3', 'H4'] as const)
      expect(check(report, id).status).toBe('pass');
    expect(report.ok).toBe(false);
  });

  it('páginas e conteúdo: página sem MediaBox, conteúdo que não é fluxo e contagem diferente do pdfjs', () => {
    const noBox = dangerousOn(
      minimalBodies().map((b, i) =>
        i === 2 ? (b as string).replace('/MediaBox [0 0 595.28 841.89] ', '') : b,
      ),
    );
    expect(noBox.details.join()).toMatch(/sem MediaBox para conferir o texto/);
    const notStream = dangerousOn(
      minimalBodies().map((b, i) =>
        i === 2 ? (b as string).replace('/Contents 4 0 R', '/Contents 1 0 R') : b,
      ),
    );
    expect(notStream.details.join()).toMatch(/não é um fluxo/);
    const twoPages = { ...cleanExtracted(), pages: 2 };
    expect(dangerousOn(minimalBodies(), twoPages).details.join()).toMatch(
      /a estrutura tem 1 página\(s\) e o pdfjs 2/,
    );
  });
});
