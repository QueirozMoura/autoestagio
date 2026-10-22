import { describe, expect, it } from 'vitest';
import {
  NormalizationError,
  companyKeyOf,
  locationKeyOf,
  normalizeJob,
  titleKeyOf,
} from '../../src/discovery/normalize.js';
import { parseNumber, parseStipend } from '../../src/discovery/stipend.js';
import { htmlToText, jaccard, toKey } from '../../src/discovery/text.js';
import { canonicalizeUrl, InvalidJobUrlError } from '../../src/discovery/url.js';
import { detectWorkMode } from '../../src/discovery/work-mode.js';
import type { RawJob } from '../../src/sources/index.js';

const raw = (overrides: Partial<RawJob> = {}): RawJob => ({
  url: 'https://vagas.exemplo.test/jobs/1',
  title: 'Estagiário de TI',
  ...overrides,
});

describe('canonicalizeUrl', () => {
  it.each([
    ['https://vagas.test/jobs/1?utm_source=a&utm_medium=b', 'https://vagas.test/jobs/1'],
    ['https://vagas.test/jobs/1?gclid=x&fbclid=y&ref=z', 'https://vagas.test/jobs/1'],
    ['https://vagas.test/jobs/1?gh_src=abc&lever-source=li', 'https://vagas.test/jobs/1'],
    ['https://vagas.test/jobs/1#apply', 'https://vagas.test/jobs/1'],
    ['https://vagas.test/jobs/1/', 'https://vagas.test/jobs/1'],
    ['https://vagas.test//jobs///1', 'https://vagas.test/jobs/1'],
    ['https://WWW.Vagas.TEST/jobs/1', 'https://vagas.test/jobs/1'],
    ['http://vagas.test/jobs/1', 'https://vagas.test/jobs/1'],
    ['https://vagas.test:443/jobs/1', 'https://vagas.test/jobs/1'],
    ['  https://vagas.test/jobs/1  ', 'https://vagas.test/jobs/1'],
  ])('normaliza %s', (input, expected) => {
    expect(canonicalizeUrl(input)).toBe(expected);
  });

  it('preserva parâmetros que identificam a vaga e ordena os restantes', () => {
    expect(canonicalizeUrl('https://v.test/vaga?id=7&utm_source=x&lang=pt')).toBe(
      'https://v.test/vaga?id=7&lang=pt',
    );
    expect(canonicalizeUrl('https://v.test/vaga?lang=pt&id=7')).toBe(
      'https://v.test/vaga?id=7&lang=pt',
    );
  });

  it('vagas com ids diferentes continuam com URLs diferentes', () => {
    expect(canonicalizeUrl('https://v.test/vaga?id=7')).not.toBe(
      canonicalizeUrl('https://v.test/vaga?id=8'),
    );
    expect(canonicalizeUrl('https://v.test/jobs/1')).not.toBe(
      canonicalizeUrl('https://v.test/jobs/2'),
    );
  });

  it('mantém porta não padrão e diferencia hosts', () => {
    expect(canonicalizeUrl('https://v.test:8443/a')).toBe('https://v.test:8443/a');
    expect(canonicalizeUrl('https://a.v.test/x')).not.toBe(canonicalizeUrl('https://v.test/x'));
  });

  it('rejeita URL inválida ou que não seja HTTP(S)', () => {
    expect(() => canonicalizeUrl('não é url')).toThrow(InvalidJobUrlError);
    expect(() => canonicalizeUrl('ftp://v.test/x')).toThrow(InvalidJobUrlError);
    expect(() => canonicalizeUrl('mailto:rh@v.test')).toThrow(InvalidJobUrlError);
  });
});

describe('texto', () => {
  it('toKey ignora acentos e pontuação, mas preserva C# e C++', () => {
    expect(toKey('  São   Paulo, SP! ')).toBe('sao paulo sp');
    expect(toKey('Dev C#')).toBe('dev c#');
    expect(toKey('Dev C++')).toBe('dev c++');
    expect(toKey('Dev C#')).not.toBe(toKey('Dev C++'));
  });

  it('htmlToText remove tags, scripts e decodifica entidades', () => {
    const html =
      '<p>Olá &amp; bem-vindo</p><script>alert(1)</script><ul><li>Item&nbsp;1</li><li>Item 2</li></ul>';
    expect(htmlToText(html)).toBe('Olá & bem-vindo\n- Item 1\n- Item 2');
    expect(htmlToText('a &#233; b &#x41; &inexistente;')).toBe('a é b A &inexistente;');
  });

  it('jaccard nunca considera conjuntos vazios semelhantes', () => {
    expect(jaccard(new Set(), new Set())).toBe(0);
    expect(jaccard(new Set(['a', 'b']), new Set(['b', 'c']))).toBeCloseTo(1 / 3);
  });
});

describe('chaves de identidade', () => {
  it('título ignora marcas de gênero', () => {
    const keys = [
      'Estagiário(a) de TI',
      'Estagiário/a de TI',
      'ESTAGIÁRIO DE TI',
      'Estagiário de T.I.',
    ];
    expect(new Set(keys.slice(0, 3).map(titleKeyOf)).size).toBe(1);
  });

  it('título distingue tecnologias e áreas', () => {
    expect(titleKeyOf('Estagiário Backend Java')).not.toBe(titleKeyOf('Estagiário Backend Python'));
    expect(titleKeyOf('Estagiário .NET')).not.toBe(titleKeyOf('Estagiário Node'));
  });

  it('empresa ignora sufixos legais e pontuação', () => {
    const keys = [
      'Alfa Tecnologia Ltda.',
      'ALFA TECNOLOGIA',
      'Alfa Tecnologia S.A.',
      'Alfa Tecnologia S/A',
      'Alfa Tecnologia Inc',
    ];
    expect(new Set(keys.map(companyKeyOf)).size).toBe(1);
    expect(companyKeyOf('Alfa Tecnologia')).not.toBe(companyKeyOf('Alfa Sistemas'));
  });

  it('local ignora a modalidade citada junto da cidade', () => {
    expect(locationKeyOf('São Paulo, SP - Híbrido')).toBe(locationKeyOf('São Paulo - SP'));
    expect(locationKeyOf('São Paulo, SP')).not.toBe(locationKeyOf('Campinas, SP'));
  });
});

describe('detectWorkMode', () => {
  const mode = (title: string, location: string | null = null, description: string | null = null) =>
    detectWorkMode({ title, location, description });

  it.each([
    ['Remoto', 'remoto'],
    ['São Paulo - Híbrido', 'hibrido'],
    ['Hybrid', 'hibrido'],
    ['Presencial - Osasco', 'presencial'],
    ['Home office', 'remoto'],
    ['Híbrido (2x remoto)', 'hibrido'],
  ])('localização "%s" → %s', (location, expected) => {
    expect(mode('Estagiário', location)).toBe(expected);
  });

  it('usa o título quando a localização não informa', () => {
    expect(mode('Estagiário Backend (Remoto)', 'São Paulo')).toBe('remoto');
  });

  it('desconhecida ou ambígua vira null, nunca presumida', () => {
    expect(mode('Estagiário', 'São Paulo, SP')).toBeNull();
    expect(mode('Estagiário', 'Remoto ou presencial')).toBeNull();
    expect(mode('Estagiário', null, 'Acesso remoto a servidores de produção')).toBeNull();
  });

  it('respeita negação', () => {
    expect(mode('Estagiário', 'Não é remoto')).toBeNull();
    expect(mode('Estagiário', 'sem home office')).toBeNull();
  });

  it('na descrição só vale o campo rotulado', () => {
    expect(mode('Estagiário', null, 'Rotina. Modalidade: Remoto. Benefícios.')).toBe('remoto');
    expect(mode('Estagiário', null, 'Modelo de trabalho: híbrido, 3x na semana')).toBe('hibrido');
  });
});

describe('bolsa', () => {
  it.each([
    ['1.800,00', 1800],
    ['1.800', 1800],
    ['1800', 1800],
    ['1.234,56', 1234.56],
    ['1,800.50', 1800.5],
    ['1500,50', 1500.5],
  ])('parseNumber("%s") = %s', (input, expected) => {
    expect(parseNumber(input)).toBe(expected);
  });

  it('extrai valor único, faixa e ignora benefícios', () => {
    expect(parseStipend('Bolsa de R$ 1.800,00 + VR')).toEqual({
      min: 1800,
      max: 1800,
      currency: 'BRL',
    });
    expect(parseStipend('R$1.200')).toEqual({ min: 1200, max: 1200, currency: 'BRL' });
    expect(parseStipend('R$ 1.100 a R$ 1.400')).toEqual({ min: 1100, max: 1400, currency: 'BRL' });
    expect(parseStipend('R$ 1.400 - 1.100')).toEqual({ min: 1100, max: 1400, currency: 'BRL' });
    expect(parseStipend('Bolsa R$ 1.500 e vale-transporte R$ 300')).toEqual({
      min: 1500,
      max: 1500,
      currency: 'BRL',
    });
  });

  it.each([
    'A combinar',
    'Compatível com o mercado',
    'Bolsa competitiva',
    'R$ 25 por hora',
    'R$ 15/h',
    'R$ 60.000 anual',
    'Bolsa-auxílio + benefícios',
    '1500 reais',
    'R$ 12',
  ])('"%s" não gera valor (fica pendente de análise)', (text) => {
    expect(parseStipend(text)).toBeNull();
  });

  it('usa a descrição só quando traz "bolsa" com valor', () => {
    const withValue = normalizeJob(
      raw({ description: '<p>Bolsa-auxílio de R$ 1.300 por mês.</p>' }),
    );
    expect(withValue.stipendMin).toBe(1300);
    expect(withValue.stipendText).toContain('R$ 1.300');

    const benefitOnly = normalizeJob(
      raw({ description: 'Oferecemos VR de R$ 40 e plano de saúde.' }),
    );
    expect(benefitOnly.stipendMin).toBeNull();
    expect(benefitOnly.stipendText).toBeNull();
  });
});

describe('normalizeJob', () => {
  it('normaliza todos os campos', () => {
    const job = normalizeJob(
      raw({
        externalId: 'X-1',
        url: 'https://www.Vagas.test/jobs/1/?utm_source=n#topo',
        title: '  Estagiário(a)   de <b>Backend</b> ',
        company: 'Alfa Tecnologia Ltda.',
        location: 'São Paulo, SP - Híbrido',
        description: '<p>Linha 1</p><p>Linha 2 &amp; mais</p>',
        compensationText: 'R$ 1.500,00',
        postedAt: '2026-10-15T10:00:00-03:00',
      }),
    );
    expect(job).toMatchObject({
      externalId: 'X-1',
      url: 'https://www.Vagas.test/jobs/1/?utm_source=n#topo',
      canonicalUrl: 'https://vagas.test/jobs/1',
      title: 'Estagiário(a) de Backend',
      titleKey: 'estagiario de backend',
      company: 'Alfa Tecnologia Ltda.',
      companyKey: 'alfa tecnologia',
      location: 'São Paulo, SP - Híbrido',
      locationKey: 'sao paulo sp',
      workMode: 'hibrido',
      description: 'Linha 1\nLinha 2 & mais',
      stipendMin: 1500,
      stipendMax: 1500,
      stipendCurrency: 'BRL',
      stipendText: 'R$ 1.500,00',
      postedAt: '2026-10-15T13:00:00.000Z',
    });
    expect(job.identityKey).toMatch(/^[0-9a-f]{32}$/);
  });

  it('campos ausentes ficam null, sem inventar valores', () => {
    const job = normalizeJob(raw());
    expect(job).toMatchObject({
      externalId: null,
      company: null,
      location: null,
      workMode: null,
      description: null,
      stipendMin: null,
      stipendText: null,
      postedAt: null,
      identityKey: null,
    });
  });

  it('data de publicação inválida vira null', () => {
    expect(normalizeJob(raw({ postedAt: '2026-13-45T00:00:00Z' })).postedAt).toBeNull();
  });

  it('o hash de conteúdo muda quando a vaga muda e é estável quando não muda', () => {
    const base = normalizeJob(raw({ description: 'Descrição' }));
    expect(normalizeJob(raw({ description: 'Descrição' })).contentHash).toBe(base.contentHash);
    expect(normalizeJob(raw({ description: 'Outra' })).contentHash).not.toBe(base.contentHash);
    // Só a URL de rastreamento mudou: não é alteração de conteúdo.
    expect(
      normalizeJob(
        raw({ description: 'Descrição', url: 'https://vagas.exemplo.test/jobs/1?utm_x=1' }),
      ).contentHash,
    ).toBe(base.contentHash);
  });

  it('rejeita vagas que não podem ser aproveitadas', () => {
    expect(() => normalizeJob(raw({ title: ' <b> </b> ' }))).toThrow(NormalizationError);
    expect(() => normalizeJob(raw({ url: 'ftp://x.test/a' }))).toThrow(NormalizationError);
  });
});

describe('normalizeJob — applyUrl', () => {
  const base = { url: 'https://jobs.exemplo.com/1', title: 'Estagiário' };

  it('preserva a URL de candidatura HTTP/HTTPS e descarta valores inválidos', () => {
    expect(normalizeJob({ ...base, applyUrl: 'https://jobs.exemplo.com/1/apply' }).applyUrl).toBe(
      'https://jobs.exemplo.com/1/apply',
    );
    expect(normalizeJob({ ...base, applyUrl: 'javascript:alert(1)' }).applyUrl).toBeNull();
    expect(normalizeJob(base).applyUrl).toBeNull();
  });

  it('não altera o hash de conteúdo (vagas já gravadas não viram "atualizadas")', () => {
    expect(
      normalizeJob({ ...base, applyUrl: 'https://jobs.exemplo.com/1/apply' }).contentHash,
    ).toBe(normalizeJob(base).contentHash);
  });
});
