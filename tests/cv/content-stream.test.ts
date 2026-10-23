import { describe, expect, it } from 'vitest';
import { renderResume } from '../../src/cv/index.js';
import {
  ALLOWED_OPERATORS,
  CMapError,
  ContentStreamError,
  IDENTITY,
  analyzeContent,
  isNearWhite,
  multiply,
  parseToUnicode,
  readFontResources,
  tokenizeContent,
  type FontResource,
  type Matrix,
} from '../../src/cv/validate/index.js';
import { dictOf, readPageNodes, readPdfStructure } from '../../src/cv/validate/pdf-objects.js';
import { fictionalResume } from '../helpers/cv-resume.js';

/** Fonte sintética: CID 1="A", 2="B", 3=" ", 4="fi" (ligadura), largura fixa de 500/1000 do corpo. */
const font = (overrides: Partial<FontResource> = {}): FontResource => ({
  name: 'F1',
  baseFont: 'ABCDEF+Teste',
  encoding: 'Identity-H',
  toUnicode: {
    map: new Map([
      [1, 'A'],
      [2, 'B'],
      [3, ' '],
      [4, 'fi'],
    ]),
    codespace: [[0, 0xffff]],
  },
  width: () => 500,
  ...overrides,
});
const PAGE: [number, number, number, number] = [0, 0, 595.28, 841.89];
const run = (content: string, fonts: FontResource[] = [font()]) =>
  analyzeContent(Buffer.from(content, 'latin1'), {
    fonts: new Map(fonts.map((f) => [f.name, f])),
    pageBox: PAGE,
  });
const text = (x: number, y: number, extra = ''): string =>
  `BT 1 0 0 1 ${x} ${y} Tm /F1 10 Tf ${extra} [<0001> 0 <0002>] TJ ET`;

describe('matrizes', () => {
  it('produto na convenção de linha: o primeiro aplicado vem à esquerda', () => {
    const translate: Matrix = [1, 0, 0, 1, 10, 20];
    const scale: Matrix = [2, 0, 0, 3, 0, 0];
    expect(multiply(translate, scale)).toEqual([2, 0, 0, 3, 20, 60]); // translada e depois escala
    expect(multiply(scale, translate)).toEqual([2, 0, 0, 3, 10, 20]);
    expect(multiply(IDENTITY, translate)).toEqual(translate);
  });

  it('dois flips verticais (como o PDFKit faz) se anulam', () => {
    const flip: Matrix = [1, 0, 0, -1, 0, 841.89];
    const both = multiply(flip, flip);
    expect(both[0]).toBe(1);
    expect(both[3]).toBe(1);
    expect(both[5]).toBeCloseTo(0, 9);
  });
});

describe('tokenizador', () => {
  it('separa operadores e operandos (números, nomes, strings, arrays, dicionários, comentários)', () => {
    const { ops } = tokenizeContent(
      '% comentário\n1 0 0 -1 0 841.89 cm\n/P << /MCID 3 >> BDC\nq BT /F1 9.5 Tf [<0001> -12.5 (ab)] TJ ET Q EMC',
    );
    expect(ops.map((o) => o.op)).toEqual(['cm', 'BDC', 'q', 'BT', 'Tf', 'TJ', 'ET', 'Q', 'EMC']);
    expect(ops[0]?.operands).toEqual([1, 0, 0, -1, 0, 841.89]);
    expect(ops[2]?.index).toBe(2);
  });

  it('não confunde "N G R" com referência dentro de um fluxo de conteúdo', () => {
    const { ops } = tokenizeContent('1 0 0 1 5 6 Tm 0 0 R');
    expect(ops.map((o) => o.op)).toEqual(['Tm', 'R']);
  });

  it('para no primeiro BI (os dados de uma imagem em linha são binários)', () => {
    const result = tokenizeContent('q BI /W 1 /H 1 ID \u0000\u0001 EI Q');
    expect(result.stoppedAt).toBe('BI');
    expect(result.ops.at(-1)?.op).toBe('BI');
  });

  it.each([
    ['array não fechado', '[<0001> 0'],
    ['caractere inesperado', '1 0 ) Tm'],
    ['operandos sem operador no fim', '1 2 3'],
    ['operandos demais', `${'1 '.repeat(100)} cm`],
  ])('falha de forma controlada: %s', (_name, source) => {
    expect(() => tokenizeContent(source)).toThrow(ContentStreamError);
  });
});

describe('interpretação do texto', () => {
  it('decodifica o texto pelo ToUnicode e posiciona pela pilha de matrizes', () => {
    const { shows, problems, text: decoded } = run(`q 1 0 0 1 100 0 cm ${text(20, 700)} Q`);
    expect(problems).toEqual([]);
    expect(decoded).toBe('AB');
    const show = shows[0];
    expect(show?.origin).toEqual([120, 700]);
    expect(show?.size).toBe(10);
    // 2 glifos × 500/1000 × 10 pt = 10 pt de largura
    expect(show?.bbox[2]).toBeCloseTo(120 + 10, 6);
    expect(show?.outside).toBe(false);
    expect(show?.fill).toEqual({ space: 'DeviceGray', components: [0] });
  });

  it('o ajuste do TJ e o espaçamento de caracteres (Tc) entram na largura', () => {
    const wide = run('BT 1 0 0 1 10 10 Tm /F1 10 Tf 2 Tc [<0001> 0 <0002>] TJ ET').shows[0];
    expect(wide?.bbox[2]).toBeCloseTo(10 + 2 * (5 + 2), 6);
    const pulled = run('BT 1 0 0 1 10 10 Tm /F1 10 Tf [<0001> 500 <0002>] TJ ET').shows[0];
    expect(pulled?.bbox[2]).toBeCloseTo(10 + 5 + -5 + 5, 6);
  });

  it('o tamanho efetivo considera as matrizes (cm de 0,5 = metade)', () => {
    const half = run(`q 0.5 0 0 0.5 0 0 cm ${text(100, 100)} Q`).shows[0];
    expect(half?.nominalSize).toBe(10);
    expect(half?.size).toBeCloseTo(5, 6);
  });

  it('CID sem mapeamento vira U+FFFD e é contado', () => {
    const shows = run('BT 1 0 0 1 10 10 Tm /F1 10 Tf [<0001> 0 <0063>] TJ ET').shows[0];
    expect(shows?.text).toBe('A�');
    expect(shows?.unmapped).toBe(1);
  });

  it('mapeamento composto aparece no texto decodificado ("fi")', () => {
    expect(run('BT 1 0 0 1 10 10 Tm /F1 10 Tf [<0004>] TJ ET').text).toBe('fi');
  });

  describe('texto totalmente fora da página', () => {
    it.each([
      ['à direita', text(900, 400)],
      ['à esquerda', text(-300, 400)],
      ['acima', text(100, 1200)],
      ['abaixo', text(100, -200)],
    ])('%s', (_name, content) => {
      expect(run(content).shows[0]?.outside).toBe(true);
    });

    it('parcialmente visível NÃO é "totalmente fora" (isso é problema de margem, do H9)', () => {
      expect(run(text(590, 400)).shows[0]?.outside).toBe(false); // começa dentro e passa da borda
      expect(run(text(-4, 400)).shows[0]?.outside).toBe(false); // termina dentro
    });

    it('a posição respeita a matriz: um cm desloca o texto para fora (e para dentro)', () => {
      expect(run(`q 1 0 0 1 2000 0 cm ${text(20, 20)} Q`).shows[0]?.outside).toBe(true);
      expect(run(`q 1 0 0 1 -2000 0 cm ${text(2020, 20)} Q`).shows[0]?.outside).toBe(false);
    });
  });

  describe('cor (texto invisível)', () => {
    it.each([
      ['RGB branco', '/DeviceRGB cs 1 1 1 scn', true],
      ['RGB quase branco', '/DeviceRGB cs 0.95 0.95 0.95 scn', true],
      ['cinza claro', '/DeviceGray cs 0.95 scn', true],
      ['CMYK sem tinta', '/DeviceCMYK cs 0 0 0 0 scn', true],
      ['RGB escuro', '/DeviceRGB cs 0.1 0.1 0.1 scn', false],
      ['azul do layout', '/DeviceRGB cs 0.12 0.23 0.37 scn', false],
      ['cinza médio (limite)', '/DeviceGray cs 0.9 scn', false],
    ])('%s', (_name, color, white) => {
      expect(run(`${color} ${text(50, 50)}`).shows[0]?.nearWhite).toBe(white);
    });

    it('isNearWhite: espaço desconhecido nunca é branco', () => {
      expect(isNearWhite('Pattern', [1, 1, 1])).toBe(false);
      expect(isNearWhite('DeviceRGB', [1, 1])).toBe(false);
    });

    it('a cor volta ao estado anterior com Q', () => {
      const { shows } = run(`q /DeviceRGB cs 1 1 1 scn ${text(10, 10)} Q ${text(10, 30)}`);
      expect(shows.map((s) => s.nearWhite)).toEqual([true, false]);
    });
  });
});

describe('lista de permissão de operadores', () => {
  it('só os operadores do PDFKit estão permitidos', () => {
    expect(Object.keys(ALLOWED_OPERATORS).sort()).toEqual(
      [
        'BDC',
        'BT',
        'CS',
        'ET',
        'EMC',
        'Q',
        'S',
        'SCN',
        'TJ',
        'Tc',
        'Tf',
        'Tm',
        'cm',
        'cs',
        'l',
        'm',
        'q',
        'scn',
        'w',
      ].sort(),
    );
  });

  it.each([
    ['modo de renderização (texto invisível)', 'BT /F1 10 Tf 3 Tr ET', 'Tr'],
    ['mostrar texto simples', 'BT /F1 10 Tf (abc) Tj ET', 'Tj'],
    ['deslocamento de texto', 'BT 10 20 Td ET', 'Td'],
    ['escala horizontal', 'BT 0 Tz ET', 'Tz'],
    ['desenhar XObject', '/Im1 Do', 'Do'],
    ['estado gráfico estendido', '/GS0 gs', 'gs'],
    ['retângulo e preenchimento (cobriria texto)', '0 0 600 800 re f', 're'],
    ['recorte (clipping)', '0 0 10 10 re W n', 're'],
    ['sombreamento', '/Sh0 sh', 'sh'],
    ['imagem em linha', 'BI /W 1 /H 1 ID x EI', 'BI'],
    ['operador desconhecido', 'xyz', 'xyz'],
  ])('recusa %s', (_name, content, op) => {
    const { problems } = run(content);
    expect(problems.join('\n')).toMatch(new RegExp(`"${op}"`));
  });

  it.each([
    ['operandos a menos em cm', '1 0 0 cm', /cm.*operandos inválidos/],
    ['Tf sem nome', '10 10 Tf', /Tf.*operandos inválidos/],
    ['TJ com operando errado', 'BT 5 TJ ET', /TJ.*operandos inválidos/],
    ['fonte inexistente nos recursos', 'BT /F9 10 Tf ET', /fonte \/F9 não existe/],
    ['espaço de cor nomeado', '/Cs1 cs', /espaço de cor \/Cs1 não permitido/],
    [
      'componentes errados em scn',
      '/DeviceRGB cs 1 1 scn',
      /2 componente\(s\) de cor para DeviceRGB/,
    ],
    ['cor fora de [0, 1]', '/DeviceGray cs 2 scn', /fora de \[0, 1\]/],
    [
      'propriedade de conteúdo marcado inesperada',
      '/P << /Foo 1 >> BDC EMC',
      /propriedades de conteúdo marcado inesperadas/,
    ],
    ['BT aninhado', 'BT BT ET', /aninhado/],
    ['ET sem BT', 'ET', /sem "BT"/],
    ['Tm fora de texto', '1 0 0 1 0 0 Tm', /fora de um objeto de texto/],
    ['TJ fora de texto', '/F1 10 Tf [<0001>] TJ', /fora de um objeto de texto/],
    ['Q sem q', 'Q', /sem "q" correspondente/],
    ['EMC sem BDC', 'EMC', /sem "BDC" correspondente/],
    ['cm dentro de texto', 'BT 1 0 0 1 0 0 cm ET', /dentro de um objeto de texto/],
    ['traçado sem caminho', 'S', /sem caminho para traçar/],
    ['bytes ímpares em TJ', 'BT /F1 10 Tf [<000102>] TJ ET', /número ímpar de bytes/],
    ['codificação não suportada', 'BT /F1 10 Tf [<0001>] TJ ET', /só Identity-H é suportada/],
  ])('%s', (_name, content, message) => {
    const fonts =
      _name === 'codificação não suportada' ? [font({ encoding: 'WinAnsiEncoding' })] : [font()];
    expect(run(content, fonts).problems.join('\n')).toMatch(message);
  });

  it('desequilíbrios no fim do fluxo', () => {
    const open = run('q BT /F1 10 Tf /P << /MCID 0 >> BDC 0 0 m').problems.join('\n');
    expect(open).toMatch(/BT" sem "ET/);
    expect(open).toMatch(/"q" sem "Q"/);
    expect(open).toMatch(/"BDC" sem "EMC"/);
    expect(open).toMatch(/caminho sem traçado/);
  });

  it('fluxo ilegível devolve um problema em vez de lançar', () => {
    const { problems, shows } = run('[<0001>');
    expect(problems[0]).toMatch(/fluxo de conteúdo ilegível/);
    expect(shows).toEqual([]);
  });

  it('um conteúdo igual ao do PDFKit passa sem problemas', () => {
    const content = [
      '1 0 0 -1 0 841.89 cm',
      '/H1 << /MCID 0 >> BDC /DeviceRGB cs 0.1 0.1 0.1 scn q 1 0 0 -1 0 841.89 cm BT 1 0 0 1 46 782 Tm /F1 20 Tf [<0001> 13 <0002>] TJ ET Q EMC',
      '/DeviceRGB cs 0.5 0.5 0.5 scn q 1 0 0 -1 0 841.89 cm BT 1 0 0 1 46 700 Tm /F1 9 Tf 0.3 Tc [<0001>] TJ ET Q',
      '7 w /DeviceRGB CS 0.1 0.2 0.3 SCN 46 600 m 500 600 l S',
    ].join('\n');
    const result = run(content);
    expect(result.problems).toEqual([]);
    expect(result.shows).toHaveLength(2);
    expect(result.shows[0]?.origin).toEqual([46, 782]); // os dois flips se anulam
  });
});

describe('ToUnicode (leitor de CMap)', () => {
  const header =
    '/CIDInit /ProcSet findresource begin 12 dict begin begincmap\n1 begincodespacerange <0000> <ffff> endcodespacerange\n';
  it('bfchar, bfrange em intervalo, bfrange em array e destinos compostos', () => {
    const cmap = parseToUnicode(
      `${header}2 beginbfchar <0001> <0041> <0002> <0066 0069> endbfchar
       2 beginbfrange <0010> <0012> <0061> <0020> <0021> [<00e9> <d83d de00>] endbfrange endcmap`,
    );
    expect(cmap.codespace).toEqual([[0, 0xffff]]);
    expect(cmap.map.get(1)).toBe('A');
    expect(cmap.map.get(2)).toBe('fi'); // glifo composto: o H7 o recusará
    expect([0x10, 0x11, 0x12].map((c) => cmap.map.get(c))).toEqual(['a', 'b', 'c']);
    expect(cmap.map.get(0x20)).toBe('é');
    expect(cmap.map.get(0x21)).toBe('😀'); // par substituto
  });

  it.each([
    ['bfchar com número ímpar de valores', 'beginbfchar <0001> endbfchar'],
    ['array com tamanho errado', 'beginbfrange <0001> <0003> [<0041>] endbfrange'],
    ['intervalo invertido', 'beginbfrange <0005> <0001> <0041> endbfrange'],
    ['destino inválido', 'beginbfchar <0001> <004> endbfchar'],
    ['código inválido', 'beginbfchar <zz> <0041> endbfchar'],
  ])('falha de forma controlada: %s', (_name, body) => {
    expect(() => parseToUnicode(`${header}${body}`)).toThrow(CMapError);
  });

  it('respeita o limite de entradas', () => {
    const many = `beginbfrange <0000> <00ff> <0041> endbfrange`;
    expect(() => parseToUnicode(`${header}${many}`, 100)).toThrow(/mais de 100 entradas/);
  });
});

describe('fontes do PDF real do renderizador', () => {
  it('lê ToUnicode, codificação e larguras das fontes da página', async () => {
    const bytes = (await renderResume(fictionalResume())).bytes;
    const structure = readPdfStructure(bytes);
    const node = readPageNodes(structure)[0];
    const { fonts, problems } = readFontResources(structure, node?.resources);
    expect(problems).toEqual([]);
    expect([...fonts.keys()].sort()).toEqual(['F2', 'F3']);
    for (const f of fonts.values()) {
      expect(f.encoding).toBe('Identity-H');
      expect(f.baseFont).toMatch(/^[A-Z]{6}\+Lato-(Regular|Bold)$/);
      expect(f.toUnicode?.map.size).toBeGreaterThan(20);
      expect(f.width(1)).toBeGreaterThan(100);
      // O renderizador desliga ligaduras: todo glifo mapeia para UM ponto de código.
      for (const value of f.toUnicode?.map.values() ?? [])
        expect(Array.from(value)).toHaveLength(1);
    }
    expect(dictOf(structure, node?.resources?.map.get('Font'))).toBeDefined();
  });
});
