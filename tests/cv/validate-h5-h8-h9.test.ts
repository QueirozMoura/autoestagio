import { beforeAll, describe, expect, it, vi } from 'vitest';
import {
  expectedContent,
  mergeLayout,
  renderResume,
  validateRenderedPdf,
  type CheckId,
  type ForbiddenSet,
  type ResolvedResume,
  type ValidateOptions,
  type ValidationReport,
} from '../../src/cv/index.js';
import {
  GEOMETRY,
  MIN_MARKER_LENGTH,
  extractForValidation,
  pdfDate,
  xmpDate,
} from '../../src/cv/validate/index.js';
import { checkGeometry } from '../../src/cv/validate/geometry.js';
import { parseXmp } from '../../src/cv/validate/metadata.js';
import type { PageInfo } from '../../src/cv/validate/pdf-objects.js';
import { craftPdf, tamperInfo, tamperSameLength } from '../helpers/cv-pdf-tamper.js';
import { fictionalResume } from '../helpers/cv-resume.js';

// Renderizar e validar PDFs (pdfjs, Poppler) é mais lento com a suíte inteira rodando em paralelo.
vi.setConfig({ testTimeout: 30_000 });

const OFF: ValidateOptions = { poppler: 'off' };
const check = (report: ValidationReport, id: CheckId) => {
  const found = report.checks.find((c) => c.id === id);
  if (found === undefined) throw new Error(`sem ${id}`);
  return found;
};
const details = (report: ValidationReport, id: CheckId): string =>
  check(report, id).details.join('\n');
const render = async (
  resume: ResolvedResume,
  layout?: ValidateOptions['layout'],
): Promise<Buffer> => (await renderResume(resume, layout === undefined ? {} : { layout })).bytes;
const withBullet = (text: string): ResolvedResume => {
  const resume = fictionalResume();
  const entry = resume.experience.entries[0];
  if (entry === undefined) throw new Error('sem entrada');
  entry.bullets[0] = text;
  return resume;
};
const forbid = (partial: Partial<ForbiddenSet>): ForbiddenSet => ({
  phrases: [],
  urls: [],
  retained: [],
  ...partial,
});

let resume: ResolvedResume;
let bytes: Buffer;
beforeAll(async () => {
  resume = fictionalResume();
  bytes = await render(resume);
});

describe('PDFs válidos passam H5, H8 e H9 (sem falsos positivos)', () => {
  it('uma e duas páginas, com e sem Poppler', async () => {
    for (const options of [OFF, {}] as ValidateOptions[]) {
      const one = await validateRenderedPdf(bytes, resume, options);
      expect(one.ok, JSON.stringify(one.checks.filter((c) => c.status !== 'pass'))).toBe(true);
      const bigger = fictionalResume({ extraBullets: 2, extraEntries: 2 });
      const two = await validateRenderedPdf(await render(bigger), bigger, options);
      expect(two.ok, JSON.stringify(two.checks.filter((c) => c.status !== 'pass'))).toBe(true);
      expect(two.pages).toBe(2);
    }
  });

  it('um ForbiddenSet realista não bloqueia dado válido', async () => {
    const report = await validateRenderedPdf(bytes, resume, {
      ...OFF,
      localMarkers: ['/home/alguem', 'usuario-local'],
      forbidden: forbid({
        phrases: ['estabilidade contínua', 'clientes reais'],
        urls: ['https://www.example.com/perfil-nao-confirmado'],
        retained: [
          {
            label: 'certificação: ano e descrição',
            contexts: [
              'Fundamentos de APIs REST — Instituto Exemplo (2026)',
              'conceitos e boas práticas de integração',
            ],
          },
        ],
      }),
    });
    expect(report.ok).toBe(true);
    expect(report.forbiddenProvided).toBe(true);
    expect(check(report, 'H5').summary).toMatch(
      /2 frase\(s\), 1 item\(ns\) retido\(s\) e 1 link\(s\)/,
    );
  });

  it('as tolerâncias de geometria estão documentadas e fixas', () => {
    expect(GEOMETRY).toEqual({
      TOLERANCE_PT: 2,
      PAGE_SIZE_PT: 0.1,
      FONT_TOLERANCE_PT: 0.1,
      SAME_LINE_OVERLAP_PT: 4,
      LINK_VERTICAL_TOLERANCE_PT: 4,
      MAX_LINK_HEIGHT_PT: 30,
      MIN_LINK_WIDTH_PT: 8,
      MIN_LINK_HEIGHT_PT: 6,
    });
  });
});

describe('H5: conteúdo proibido e informações retidas', () => {
  it('frase rejeitada no PDF, sem diferenciar maiúsculas', async () => {
    const bad = withBullet('Plataforma estável, com CLIENTES Reais e entrega contínua.');
    const report = await validateRenderedPdf(await render(bad), bad, {
      ...OFF,
      forbidden: forbid({ phrases: ['clientes reais'] }),
    });
    expect(check(report, 'H5').status).toBe('fail');
    expect(details(report, 'H5')).toMatch(
      /frase de afirmação rejeitada presente no PDF: "clientes reais"/,
    );
    expect(report.ok).toBe(false);
  });

  it('frase quebrada entre duas linhas é encontrada', async () => {
    let wrapped: ResolvedResume | undefined;
    for (let words = 8; words < 70 && wrapped === undefined; words++) {
      const candidate = withBullet(
        `${'palavra '.repeat(words)}clientes reais de verdade no produto.`,
      );
      const lines = (await extractForValidation(await render(candidate))).streamText.split('\n');
      if (lines.some((line) => line.trimEnd().endsWith('clientes'))) wrapped = candidate;
    }
    if (wrapped === undefined) throw new Error('não consegui quebrar a frase entre linhas');
    const report = await validateRenderedPdf(await render(wrapped), wrapped, {
      ...OFF,
      forbidden: forbid({ phrases: ['clientes reais'] }),
    });
    expect(check(report, 'H5').status).toBe('fail');
  });

  it('espaços sobrando no texto de origem não colam palavras no PDF (o PDFKit colaria 3 ou mais)', async () => {
    const messy = withBullet('Plataforma com CLIENTES    Reais   e   entrega contínua.');
    const before = JSON.stringify(messy);
    const pdf = await render(messy);
    expect(JSON.stringify(messy)).toBe(before); // a entrada não é alterada
    const text = (await extractForValidation(pdf)).streamText;
    expect(text).toContain('Plataforma com CLIENTES Reais e entrega contínua.');
    expect(text).not.toContain('CLIENTESReais');
    const report = await validateRenderedPdf(pdf, messy, {
      ...OFF,
      forbidden: forbid({ phrases: ['clientes reais'] }),
    });
    expect(check(report, 'H2').status).toBe('pass'); // o validador compara sem depender de espaços
    expect(check(report, 'H5').status).toBe('fail'); // e a frase proibida é achada
  });

  it('frase quebrada em duas linhas e palavra quebrada no hífen também são encontradas', async () => {
    let wrapped: ResolvedResume | undefined;
    for (let words = 8; words < 70 && wrapped === undefined; words++) {
      const candidate = withBullet(`${'palavra '.repeat(words)}produto de e-commerce completo.`);
      const extracted = await extractForValidation(await render(candidate));
      if (extracted.streamText.split('\n').some((line) => line.endsWith('e-'))) wrapped = candidate;
    }
    if (wrapped === undefined) throw new Error('não consegui provocar a quebra no hífen');
    const report = await validateRenderedPdf(await render(wrapped), wrapped, {
      ...OFF,
      forbidden: forbid({ phrases: ['produto de e-commerce'] }),
    });
    expect(check(report, 'H5').status).toBe('fail');
  });

  it('fronteira de palavra: a frase não casa no meio de outra palavra', async () => {
    const ok = withBullet('Mantemos abase de dados e muitos clientes reaisx por aqui.');
    const report = await validateRenderedPdf(await render(ok), ok, {
      ...OFF,
      forbidden: forbid({ phrases: ['base de dados', 'clientes reais'] }),
    });
    expect(check(report, 'H5').status).toBe('pass');
  });

  it('frase curta demais é recusada (falha fechada), em vez de banir um termo comum isolado', async () => {
    const report = await validateRenderedPdf(bytes, resume, {
      ...OFF,
      forbidden: forbid({ phrases: ['IA'] }),
    });
    expect(check(report, 'H5').status).toBe('fail');
    expect(details(report, 'H5')).toMatch(/sem contexto suficiente/);
  });

  it('informação retida só vale com contexto: o ano isolado não é proibido e não bloqueia o período', async () => {
    // O período "2025 – 2026" do currículo é legítimo; só o contexto completo da certificação é proibido.
    const withContext = forbid({
      retained: [
        {
          label: 'certificação',
          contexts: ['Fundamentos de APIs REST — Instituto Exemplo (2026)'],
        },
      ],
    });
    expect(
      check(await validateRenderedPdf(bytes, resume, { ...OFF, forbidden: withContext }), 'H5')
        .status,
    ).toBe('pass');

    const bare = await validateRenderedPdf(bytes, resume, {
      ...OFF,
      forbidden: forbid({
        retained: [
          { label: 'certificação: ano', contexts: ['(2026)'] },
          { label: 'só o ano', contexts: ['2026'] },
        ],
      }),
    });
    expect(check(bare, 'H5').status).toBe('fail');
    expect(details(bare, 'H5')).toMatch(/informação retida sem contexto suficiente/);
    expect(details(bare, 'H5')).not.toMatch(/presente no PDF/);
  });

  it('o ano e a descrição retidos da certificação, quando aparecem COM contexto, falham', async () => {
    const leaky = fictionalResume({
      certifications: [
        'Fundamentos de APIs REST — Instituto Exemplo (2026): conceitos e boas práticas de integração.',
      ],
    });
    const report = await validateRenderedPdf(await render(leaky), leaky, {
      ...OFF,
      forbidden: forbid({
        retained: [
          {
            label: 'certificação: ano e descrição',
            contexts: [
              'Fundamentos de APIs REST — Instituto Exemplo (2026)',
              'conceitos e boas práticas de integração',
            ],
          },
        ],
      }),
    });
    expect(check(report, 'H5').status).toBe('fail');
    expect(details(report, 'H5').match(/informação retida presente no PDF/g)).toHaveLength(2);
  });

  it('link não confirmado: comparação por URL inteira (barra final e maiúsculas no host não enganam; prefixo não bloqueia)', async () => {
    for (const url of [
      'https://oficina.example.com',
      'HTTPS://OFICINA.EXAMPLE.COM/',
      'https://www.example.com/maria-exemplo/',
    ]) {
      const report = await validateRenderedPdf(bytes, resume, {
        ...OFF,
        forbidden: forbid({ urls: [url] }),
      });
      expect(check(report, 'H5').status, url).toBe('fail');
      expect(details(report, 'H5')).toMatch(/link não confirmado presente no PDF/);
    }
    // Um perfil é prefixo de repositórios sob ele: bloquear o perfil não bloqueia os repositórios.
    const prefix = await validateRenderedPdf(bytes, resume, {
      ...OFF,
      forbidden: forbid({
        urls: ['https://github.example.com/maria', 'https://github.example.com'],
      }),
    });
    expect(check(prefix, 'H5').status).toBe('pass');
  });

  it.each([
    ['undefined', 'Total de usuários: undefined'],
    ['null', 'Tecnologias: null'],
    ['NaN', 'Cobertura de NaN por cento'],
    ['Infinity', 'Escala até Infinity usuários'],
    ['[object Object]', 'Projeto [object Object]'],
    ['{{ }}', 'Olá {{nome}}, tudo bem'],
    ['${ }', 'Valor ${total} aqui'],
    ['lorem ipsum', 'Lorem Ipsum dolor sit'],
  ])('texto inválido: %s', async (_token, text) => {
    const bad = withBullet(text);
    const report = await validateRenderedPdf(await render(bad), bad, OFF);
    expect(check(report, 'H5').status).toBe('fail');
    expect(details(report, 'H5')).toMatch(/texto inválido no PDF/);
    expect(check(report, 'H5').summary).toMatch(/problema/);
  });

  it('texto inválido respeita fronteira de palavra e as exceções declaradas', async () => {
    const fine = withBullet(
      'Anulado, Nullable, banana e nanquim; "nullify" e annulled não são valores nulos.',
    );
    expect(check(await validateRenderedPdf(await render(fine), fine, OFF), 'H5').status).toBe(
      'pass',
    );
    const legit = withBullet('Linguagem com null safety e tipos opcionais.');
    const blocked = await validateRenderedPdf(await render(legit), legit, OFF);
    expect(check(blocked, 'H5').status).toBe('fail');
    const allowed = await validateRenderedPdf(await render(legit), legit, {
      ...OFF,
      forbidden: forbid({ allowTokens: ['null safety'] }),
    });
    expect(check(allowed, 'H5').status).toBe('pass');
  });

  it('sem ForbiddenSet o relatório diz que nada foi informado', async () => {
    const report = await validateRenderedPdf(bytes, resume, OFF);
    expect(report.forbiddenProvided).toBe(false);
    expect(check(report, 'H5').summary).toMatch(/nenhum conjunto de proibições informado/);
  });

  it('metadados também são varridos: frase proibida no Info', async () => {
    const tampered = tamperInfo(bytes, 'Author', 'clientes reais zzzzzzz');
    const report = await validateRenderedPdf(tampered, resume, {
      ...OFF,
      forbidden: forbid({ phrases: ['clientes reais'] }),
    });
    expect(check(report, 'H5').status).toBe('fail');
    expect(check(report, 'H8').status).toBe('fail'); // e o Info diverge do esperado
  });
});

describe('H8: metadados e informação local', () => {
  it('Info e XMP idênticos ao esperado, com as datas fixas', async () => {
    const report = await validateRenderedPdf(bytes, resume, OFF);
    expect(check(report, 'H8').status).toBe('pass');
    expect(pdfDate(new Date('2026-01-01T00:00:00Z'))).toBe('D:20260101000000Z');
    expect(xmpDate(new Date('2026-01-01T00:00:00Z'))).toBe('2026-01-01T00:00:00Z');
    const other = await renderResume(resume, {
      layout: { metadata: { date: new Date('2027-02-03T04:05:06Z') } },
    });
    const wrongDate = await validateRenderedPdf(other.bytes, resume, OFF);
    expect(check(wrongDate, 'H8').status).toBe('fail'); // a data difere da esperada pelo layout
    const right = await validateRenderedPdf(other.bytes, resume, {
      ...OFF,
      layout: { metadata: { date: new Date('2027-02-03T04:05:06Z') } },
    });
    expect(check(right, 'H8').status).toBe('pass');
  });

  it.each([
    ['produtor', () => tamperInfo(bytes, 'Producer', 'AutoEstagiX'), /Info \/Producer diverge/],
    [
      'data de criação (não determinística)',
      () => tamperInfo(bytes, 'CreationDate', 'D:20260101000001Z'),
      /Info \/CreationDate diverge/,
    ],
    [
      'data de modificação',
      () => tamperInfo(bytes, 'ModDate', 'D:20991231235959Z'),
      /Info \/ModDate diverge/,
    ],
    ['autor', () => tamperInfo(bytes, 'Author', 'Outra Pessoa Qualquer!'), /Info \/Author diverge/],
    [
      'chave extra no Info (/ModDate vira /Trapped)',
      () => tamperSameLength(bytes, '/ModDate ', '/Trapped '),
      /metadado inesperado no Info: \/Trapped/,
    ],
    [
      'XMP: data de criação',
      () =>
        tamperSameLength(
          bytes,
          '<xmp:CreateDate>2026-01-01T00:00:00Z<',
          '<xmp:CreateDate>2026-01-01T00:00:01Z<',
        ),
      /XMP xmp:CreateDate diverge/,
    ],
    [
      'XMP: autor',
      () =>
        tamperSameLength(
          bytes,
          '<rdf:li>Maria Exemplo da Silva</rdf:li>',
          '<rdf:li>Maria Exemplo da Silvb</rdf:li>',
        ),
      /XMP dc:creator diverge/,
    ],
    [
      'XMP: propriedade inesperada (pdf:Keywords)',
      () =>
        tamperSameLength(
          bytes,
          '<pdf:Producer>AutoEstagio</pdf:Producer>',
          '<pdf:Keywords>AutoEstagio</pdf:Keywords>',
        ),
      /propriedade XMP inesperada: <pdf:Keywords>/,
    ],
    [
      'XMP: espaço de nomes desconhecido',
      () => tamperSameLength(bytes, 'http://ns.adobe.com/pdf/1.3/', 'http://ns.adobe.com/pdf/9.9/'),
      /espaço de nomes XMP inesperado/,
    ],
    [
      'idioma',
      () => tamperSameLength(bytes, '/Lang (pt-BR)', '/Lang (en-US)'),
      /idioma \(\/Lang\) "en-US"/,
    ],
    [
      'estrutura marcada desligada',
      () => tamperSameLength(bytes, '/Marked true', '/Marked null'),
      /sem estrutura marcada/,
    ],
    [
      '/ID alterado',
      () => {
        const raw = bytes.toString('latin1');
        const id = /\/ID \[<([0-9a-f]+)> <([0-9a-f]+)>\]/.exec(raw);
        if (id === null) throw new Error('sem /ID');
        const second = id[2] ?? '';
        const flipped = `${second.slice(0, -1)}${second.endsWith('0') ? '1' : '0'}`;
        return tamperSameLength(bytes, `<${second}>]`, `<${flipped}>]`);
      },
      /as duas metades do \/ID diferem/,
    ],
  ])('adulteração: %s', async (_name, make, message) => {
    const report = await validateRenderedPdf(make(), resume, OFF);
    expect(check(report, 'H8').status).toBe('fail');
    expect(details(report, 'H8')).toMatch(message);
    expect(report.ok).toBe(false);
  });

  it('caminho local nos metadados (Unix, no Info e no XMP)', async () => {
    const inInfo = await validateRenderedPdf(
      tamperInfo(bytes, 'Author', '/home/maria/projeto/cv'),
      resume,
      OFF,
    );
    expect(check(inInfo, 'H8').status).toBe('fail');
    expect(details(inInfo, 'H8')).toMatch(/caminho Unix absoluto nos metadados/);

    const inXmp = await validateRenderedPdf(
      tamperSameLength(bytes, '<xmp:CreatorTool>AutoEstagio<', '<xmp:CreatorTool>/home/x/abc<'),
      resume,
      OFF,
    );
    expect(check(inXmp, 'H8').status).toBe('fail');
    expect(details(inXmp, 'H8')).toMatch(/caminho Unix absoluto nos metadados/);
  });

  it('marcador de ambiente: PDFKit no produtor e marcador do chamador em lugar inesperado', async () => {
    const pdfkit = await validateRenderedPdf(
      tamperInfo(bytes, 'Producer', 'PDFKit-----'),
      resume,
      OFF,
    );
    expect(details(pdfkit, 'H8')).toMatch(/marcador do ambiente "PDFKit"/);

    const marker = await validateRenderedPdf(
      tamperSameLength(bytes, '<xmp:CreatorTool>AutoEstagio<', '<xmp:CreatorTool>maquina01xx<'),
      resume,
      { ...OFF, localMarkers: ['maquina01'] },
    );
    expect(check(marker, 'H8').status).toBe('fail');
    expect(details(marker, 'H8')).toMatch(/marcador do ambiente "maquina01" nos metadados/);
  });

  it('um marcador que coincide com o nome legítimo da pessoa NÃO acusa (valores esperados saem da varredura)', async () => {
    const report = await validateRenderedPdf(bytes, resume, {
      ...OFF,
      localMarkers: ['Maria', 'Exemplo', 'AutoEstagio'],
    });
    expect(check(report, 'H8').status).toBe('pass');
  });

  it('marcador curto demais é recusado (ignorá-lo seria inseguro)', async () => {
    const report = await validateRenderedPdf(bytes, resume, { ...OFF, localMarkers: ['ab'] });
    expect(check(report, 'H8').status).toBe('fail');
    expect(details(report, 'H8')).toMatch(
      new RegExp(`marcador local curto demais.*${MIN_MARKER_LENGTH}`),
    );
  });

  it('estrutura ilegível ou acima dos limites: falha fechada em H8 e H9, com o resto da validação intacta', async () => {
    const report = await validateRenderedPdf(bytes, resume, {
      ...OFF,
      structureLimits: { maxObjects: 10 },
    });
    expect(details(report, 'H8')).toMatch(/TOO_MANY_OBJECTS/);
    expect(details(report, 'H9')).toMatch(/TOO_MANY_OBJECTS/);
    for (const id of ['H1', 'H2', 'H3', 'H4'] as const)
      expect(check(report, id).status).toBe('pass');
    expect(report.ok).toBe(false);
  });

  it('XMP: DOCTYPE/ENTITY, envelope ausente, valores repetidos e atributos soltos são recusados', () => {
    const good = `<?xpacket begin="x" id="W5M0MpCehiHzreSzNTczkc9d"?><x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description rdf:about="" xmlns:xmp="http://ns.adobe.com/xap/1.0/"><xmp:CreateDate>2026-01-01T00:00:00Z</xmp:CreateDate><xmp:CreatorTool>A &amp; B</xmp:CreatorTool></rdf:Description></rdf:RDF></x:xmpmeta><?xpacket end="w"?>`;
    const parsed = parseXmp(good);
    expect(parsed.values.creatorTool).toBe('A & B');
    expect(parsed.problems.join()).not.toMatch(/DOCTYPE|envelope|inesperado/);
    expect(parseXmp(`<!DOCTYPE x [<!ENTITY a "b">]>${good}`).problems.join()).toMatch(
      /DOCTYPE ou ENTITY/,
    );
    expect(parseXmp('<x:xmpmeta></x:xmpmeta>').problems.join()).toMatch(/envelope/);
    expect(
      parseXmp(
        good.replace('<xmp:CreatorTool>', '<xmp:CreatorTool>x</xmp:CreatorTool><xmp:CreatorTool>'),
      ).problems.join(),
    ).toMatch(/repetido/);
    expect(
      parseXmp(good.replace('rdf:about=""', 'rdf:about="" xmp:Extra="1"')).problems.join(),
    ).toMatch(/atributo inesperado/);
  });
});

describe('H9: geometria e conteúdo fora das margens', () => {
  it('margens maiores que as do PDF: texto e links ficam fora', async () => {
    for (const [margin, message] of [
      [{ left: 100 }, /além da margem esquerda/],
      [{ right: 120 }, /além da margem direita/],
      [{ bottom: 300 }, /abaixo da margem inferior/],
      [{ top: 150 }, /acima da margem superior/],
    ] as const) {
      const report = await validateRenderedPdf(bytes, resume, { ...OFF, layout: { margin } });
      expect(check(report, 'H9').status, JSON.stringify(margin)).toBe('fail');
      expect(details(report, 'H9')).toMatch(message);
    }
  });

  it('formato diferente de A4 (Carta) é recusado', async () => {
    const letter = await render(resume, { page: { width: 612, height: 792 } });
    const report = await validateRenderedPdf(letter, resume, OFF);
    expect(check(report, 'H9').status).toBe('fail');
    expect(details(report, 'H9')).toMatch(
      /612\.00 × 792\.00 pt em vez de 595\.28 × 841\.89 \(A4\)/,
    );
    expect(details(report, 'H9')).toMatch(/MediaBox \[0 0 612 792\]/);
  });

  it('fonte menor que o mínimo e texto sobreposto', async () => {
    const tiny = await craftPdf((pdf) => {
      pdf
        .fontSize(6)
        .text('Texto minúsculo demais para ser lido por pessoas', 46, 100, { lineBreak: false });
    });
    expect(details(await validateRenderedPdf(tiny, resume, OFF), 'H9')).toMatch(
      /fonte pequena demais.*6\.00 pt/,
    );

    const overlapped = await craftPdf((pdf) => {
      pdf.fontSize(10).text('Primeira linha de texto', 46, 100, { lineBreak: false });
      pdf.text('Segunda linha por cima da primeira', 46, 103, { lineBreak: false });
    });
    expect(details(await validateRenderedPdf(overlapped, resume, OFF), 'H9')).toMatch(
      /sobreposição\(ões\) de texto/,
    );
  });

  it('texto que ultrapassa a borda direita é recusado', async () => {
    const off = await craftPdf((pdf) => {
      pdf
        .fontSize(10)
        .text('Texto além da borda direita da página', 540, 100, { lineBreak: false });
    });
    expect(details(await validateRenderedPdf(off, resume, OFF), 'H9')).toMatch(
      /além da margem direita/,
    );
  });

  it('título de seção e título de entrada órfãos no fim da página', async () => {
    const heading = await craftPdf((pdf) => {
      pdf.fontSize(10).text('RESUMO PROFISSIONAL', 46, 780, { lineBreak: false });
      pdf.addPage();
      pdf.fontSize(10).text('Texto da página seguinte.', 46, 60, { lineBreak: false });
    });
    expect(details(await validateRenderedPdf(heading, resume, OFF), 'H9')).toMatch(
      /título de seção órfão no fim da página 1/,
    );

    const entry = await craftPdf((pdf) => {
      pdf.fontSize(10).text('Projeto oficina — Desenvolvedora Full Stack | 2025 – 2026', 46, 780, {
        lineBreak: false,
      });
      pdf.addPage();
      pdf.fontSize(10).text('Texto da página seguinte.', 46, 60, { lineBreak: false });
    });
    expect(details(await validateRenderedPdf(entry, resume, OFF), 'H9')).toMatch(
      /título de entrada órfão no fim da página 1/,
    );

    // Título como ÚLTIMA linha do documento (sem conteúdo depois) também é órfão.
    const last = await craftPdf((pdf) => {
      pdf.fontSize(10).text('Texto qualquer no começo.', 46, 60, { lineBreak: false });
      pdf.text('OUTROS PROJETOS', 46, 200, { lineBreak: false });
    });
    expect(details(await validateRenderedPdf(last, resume, OFF), 'H9')).toMatch(
      /título de seção órfão no fim da página 1/,
    );
  });

  describe('áreas clicáveis', () => {
    const url = 'https://x.example.com/a';
    const linkResume = (): ResolvedResume => {
      const r = fictionalResume({ links: false });
      r.header.links = [{ id: 'l', label: 'GitHub', url }];
      return r;
    };
    const withLink = (
      rect: [number, number, number, number],
      extra?: [number, number, number, number],
    ) =>
      craftPdf((pdf) => {
        pdf.fontSize(10).text(`GitHub: ${url}`, 46, 100, { lineBreak: false });
        pdf.link(...rect, url);
        if (extra !== undefined) pdf.link(...extra, url);
      });
    const linkProblems = async (
      rect: [number, number, number, number],
      extra?: [number, number, number, number],
    ) => details(await validateRenderedPdf(await withLink(rect, extra), linkResume(), OFF), 'H9');

    it('área bem posicionada não gera problema de geometria', async () => {
      expect(await linkProblems([46, 98, 150, 14])).not.toMatch(/área clicável/);
    });

    it('fora das margens, pequena demais, grande demais, sem texto por baixo e sobreposta', async () => {
      expect(await linkProblems([5, 98, 60, 14])).toMatch(/fora das margens/);
      expect(await linkProblems([46, 98, 3, 3])).toMatch(/pequena demais/);
      expect(await linkProblems([46, 98, 400, 80])).toMatch(/grande demais.*link invisível/);
      const noText = await validateRenderedPdf(
        await craftPdf((pdf) => {
          pdf.fontSize(10).text(`GitHub: ${url}`, 46, 100, { lineBreak: false });
          pdf.link(300, 500, 100, 12, url);
        }),
        linkResume(),
        OFF,
      );
      expect(details(noText, 'H9')).toMatch(/sem texto por baixo/);
      expect(await linkProblems([46, 98, 150, 14], [60, 98, 150, 14])).toMatch(
        /áreas clicáveis sobrepostas/,
      );
    });
  });

  it('caixas da página (testadas direto com páginas sintéticas): CropBox, caixas extras, rotação e contagem', async () => {
    const extracted = await extractForValidation(bytes);
    const expected = expectedContent(resume);
    const layout = mergeLayout();
    const good: PageInfo = {
      num: 1,
      mediaBox: [0, 0, 595.28, 841.89],
      rotate: 0,
      userUnit: 1,
      extraBoxes: [],
    };
    const run = (pages: PageInfo[] | undefined) =>
      checkGeometry({
        extracted,
        expected,
        layout,
        pages,
        structureError: pages === undefined ? 'sem estrutura' : undefined,
      });
    expect(run([good]).status).toBe('pass');
    expect(run([{ ...good, cropBox: [0, 0, 300, 400] }]).details.join()).toMatch(
      /CropBox diferente do MediaBox/,
    );
    expect(run([{ ...good, extraBoxes: ['TrimBox'] }]).details.join()).toMatch(
      /caixas extras \(TrimBox\)/,
    );
    const withoutBox: PageInfo = { ...good };
    delete withoutBox.mediaBox;
    expect(run([withoutBox]).details.join()).toMatch(/sem MediaBox/);
    expect(run([good, good]).details.join()).toMatch(/a estrutura tem 2 página\(s\) e o pdfjs 1/);
    expect(run(undefined).details.join()).toMatch(
      /não foi possível conferir MediaBox.*sem estrutura/,
    );
  });
});
