import { describe, expect, it } from 'vitest';
import { ConfigError } from '../../src/config/index.js';
import {
  SourceConfigError,
  createDefaultRegistry,
  isBrazilLocation,
  isInternshipTitle,
  isItRelated,
  parseSourcesConfig,
} from '../../src/sources/index.js';
import { toIsoDate, unescapeEntities } from '../../src/sources/filters.js';

describe('isInternshipTitle', () => {
  it.each([
    'Estagiário(a) de Desenvolvimento',
    'ESTAGIÁRIA QA',
    'Estágio em Dados',
    'Programa de Estágio 2027',
    'Software Engineer Intern',
    'Data Science Internship',
    'Customer Onboarding Intern - Brazil',
    'Summer Interns',
  ])('"%s" é estágio', (title) => {
    expect(isInternshipTitle(title)).toBe(true);
  });

  it.each([
    'Senior Software Engineer',
    'International Sales Manager',
    'Internal Tools Engineer',
    'Desenvolvedor Júnior',
    'Trainee de Tecnologia',
    'Banco de Talentos Jovem Aprendiz',
    'Analista de Suporte',
  ])('"%s" não é estágio', (title) => {
    expect(isInternshipTitle(title)).toBe(false);
  });
});

describe('isBrazilLocation', () => {
  it.each([
    'São Paulo',
    'Sao Paulo, SP',
    'Brazil - Sao Paulo',
    'São Paulo, São Paulo, Brazil',
    'Brasil',
    'Remote - LATAM',
    'Campinas, SP',
    'Rio de Janeiro',
  ])('"%s" é Brasil', (location) => {
    expect(isBrazilLocation(location)).toBe(true);
  });

  it.each(['New York, NY', 'London, UK', 'Remote', 'Singapore', 'Lisboa', '', 'Spokane'])(
    '"%s" não é Brasil',
    (location) => {
      expect(isBrazilLocation(location)).toBe(false);
    },
  );

  it('ignora valores ausentes e aceita vários locais', () => {
    expect(isBrazilLocation(undefined, null)).toBe(false);
    expect(isBrazilLocation('Remote', undefined, 'São Paulo')).toBe(true);
  });
});

describe('isItRelated (heurística de relatório)', () => {
  it.each([
    'Estagiário de Desenvolvimento Backend',
    'Data Scientist Intern',
    'Estágio em QA',
    'Estágio em Tecnologia da Informação',
    'Software Engineering Intern',
    'Estagiário de Suporte Técnico',
    'Estágio em Infraestrutura',
  ])('"%s" cita tecnologia', (title) => {
    expect(isItRelated(title)).toBe(true);
  });

  it.each([
    'Estagiário(a) Corporate Desk',
    'Social Media Intern',
    'Estágio Comercial e Wealth Management',
  ])('"%s" não cita tecnologia', (title) => {
    expect(isItRelated(title)).toBe(false);
  });
});

describe('utilitários', () => {
  it('unescapeEntities desfaz só uma camada de escape', () => {
    expect(unescapeEntities('&lt;p&gt;a &amp;amp; b&lt;/p&gt;')).toBe('<p>a &amp; b</p>');
    expect(unescapeEntities('it&#39;s &quot;ok&quot;')).toBe('it\'s "ok"');
    expect(unescapeEntities('&desconhecida;')).toBe('&desconhecida;');
  });

  it('toIsoDate converte datas e ignora o que for inválido', () => {
    expect(toIsoDate('2026-10-01T09:00:00-03:00')).toBe('2026-10-01T12:00:00.000Z');
    expect(toIsoDate(1_790_000_000_000)).toBe('2026-09-21T14:13:20.000Z');
    expect(toIsoDate('ontem')).toBeUndefined();
    expect(toIsoDate(null)).toBeUndefined();
  });
});

describe('configuração dos alvos e registro padrão', () => {
  it('traz padrões seguros: só Brasil e instância global', () => {
    const [t] = parseSourcesConfig({ targets: [{ kind: 'lever', slug: 'x', name: 'X' }] }).targets;
    expect(t).toMatchObject({ brazilOnly: true, instance: 'global', enabled: true });
  });

  it('a instância "eu" só vale para o Lever', () => {
    expect(() =>
      parseSourcesConfig({
        targets: [{ kind: 'greenhouse', slug: 'x', name: 'X', instance: 'eu' }],
      }),
    ).toThrow(ConfigError);
    expect(
      parseSourcesConfig({ targets: [{ kind: 'lever', slug: 'x', name: 'X', instance: 'eu' }] })
        .targets,
    ).toHaveLength(1);
  });

  it('o registro padrão tem Greenhouse, Lever e Ashby, e nenhum outro adaptador', () => {
    expect(createDefaultRegistry().kinds()).toEqual(['ashby', 'greenhouse', 'lever']);
  });

  it('alvos de plataformas sem adaptador falham antes de qualquer requisição', () => {
    const config = parseSourcesConfig({
      targets: [{ kind: 'smartrecruiters', slug: 'x', name: 'X' }],
    });
    expect(() => createDefaultRegistry().create(config)).toThrow(SourceConfigError);
  });
});
