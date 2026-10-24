import { describe, expect, it } from 'vitest';
import {
  AREAS,
  JOB_AREAS,
  canonicalProfileAreas,
  classifyJobAreas,
  evaluateJob,
  unknownProfileAreas,
} from '../../src/eligibility/index.js';
import { job, profile } from '../helpers/eligibility.js';

const area = (title: string, description: string | null = null, areas: string[] = ['todas']) =>
  evaluateJob(profile({ areas }), job({ title, description })).criteria.find(
    (c) => c.id === 'area',
  );

describe('áreas de TI: todas com a mesma prioridade', () => {
  it('as áreas de currículo não mudaram; as de vaga acrescentam as novas', () => {
    expect([...AREAS]).toEqual([
      'desenvolvimento',
      'qa',
      'suporte',
      'infraestrutura',
      'dados',
      'banco-de-dados',
    ]);
    expect(JOB_AREAS).toEqual(
      expect.arrayContaining([
        ...AREAS,
        'seguranca',
        'governanca',
        'sistemas-corporativos',
        'automacao',
        'ti-geral',
      ]),
    );
  });

  // Antes/depois dos 26 títulos auditados (o "antes" está na documentação do plano).
  it.each([
    ['Estágio em Desenvolvimento de Software', 'atende', 'desenvolvimento'],
    ['Estágio em Help Desk', 'atende', 'suporte'],
    ['Estágio em Suporte de Informática e Elétrica', 'atende', 'suporte'],
    ['Estágio em TI', 'atende', 'ti-geral'],
    ['Estágio em Governança de TI', 'atende', 'governanca'],
    ['Estágio em Segurança da Informação', 'atende', 'seguranca'],
    ['Estágio em Cibersegurança (SOC)', 'atende', 'seguranca'],
    ['Estágio em Operações de TI', 'atende', 'ti-geral'],
    ['Estágio em Atendimento de TI', 'atende', 'suporte'],
    ['Estágio em Transformação Digital', 'indeterminado', undefined],
    ['Estágio em Automação de Processos (RPA)', 'atende', 'automacao'],
    ['Estágio em ERP / Protheus', 'atende', 'sistemas-corporativos'],
    ['Estágio em Sistemas Corporativos (SAP)', 'atende', 'sistemas-corporativos'],
    ['Estágio em Cloud e DevOps', 'atende', 'infraestrutura'],
    ['Estágio em Redes e Telecom', 'atende', 'infraestrutura'],
    ['Estágio em Business Intelligence', 'atende', 'dados'],
    ['Estágio em Analytics', 'atende', 'dados'],
    ['Estágio em Compliance de TI', 'atende', 'governanca'],
    ['Estágio em Data Science', 'atende', 'dados'],
    ['Estagiário de Analista de Sistemas', 'atende', 'sistemas-corporativos'],
    ['Estágio em Engenharia de Produção', 'nao_atende', undefined],
    ['Estágio em Engenharia de Software', 'atende', 'desenvolvimento'],
    ['Estagiário de Customer Success', 'nao_atende', undefined],
    ['Estágio em Marketing Digital', 'nao_atende', undefined],
    ['Estágio em Setup', 'indeterminado', undefined],
    ['Estágio Administrativo - Soluções Digitais', 'nao_atende', undefined],
  ])('%s → %s', (title, outcome, expectedArea) => {
    expect(area(title)?.outcome).toBe(outcome);
    if (expectedArea !== undefined)
      expect(classifyJobAreas(title, null).fromTitle).toContain(expectedArea);
  });

  it('corrige os falsos negativos: Operações, Atendimento e Compliance de TI não são "fora de TI"', () => {
    for (const title of [
      'Estágio em Operações de TI',
      'Estágio em Atendimento de TI',
      'Estágio em Compliance de TI',
    ])
      expect(classifyJobAreas(title, null).nonIt).toBe(false);
  });

  it('suporte a aplicações, service desk e técnico de TI também contam como suporte', () => {
    for (const title of [
      'Estágio em Suporte a Aplicações',
      'Estágio Service Desk N1',
      'Estagiário Técnico de TI',
      'IT Support Intern',
    ])
      expect(classifyJobAreas(title, null).fromTitle).toContain('suporte');
  });

  it('desenvolvimento de negócios/humano não é desenvolvimento de software', () => {
    for (const title of [
      'Estágio em Desenvolvimento de Negócios',
      'Estágio em Desenvolvimento Humano e Organizacional',
    ])
      expect(area(title)?.outcome).not.toBe('atende');
  });

  it('infraestrutura civil/predial e proteção de dados (jurídico) não são TI', () => {
    expect(classifyJobAreas('Estágio em Infraestrutura Civil', null).fromTitle).toEqual([]);
    expect(
      classifyJobAreas('Estágio em Proteção de Dados e Privacidade', null).fromTitle,
    ).not.toContain('dados');
  });

  it('empresa de tecnologia não faz de toda função uma função de TI', () => {
    const fake =
      'Somos uma empresa de tecnologia inovadora, líder em software e plataformas digitais.';
    expect(area('Estágio em Marketing', fake)?.outcome).toBe('nao_atende');
    expect(area('Estágio em Recursos Humanos', fake)?.outcome).toBe('nao_atende');
    expect(area('Estágio Comercial', fake)?.outcome).toBe('nao_atende');
  });

  it('sinal fraco no título só vale com atividades de TI na descrição (≥ 2 termos específicos)', () => {
    const real =
      'Atividades: atendimento aos usuários via help desk, abertura de chamados e suporte técnico.';
    const result = area('Estágio em Tecnologia', real);
    expect(result?.outcome).toBe('atende');
    expect(result?.detail).toContain('descrição confirma');
    expect(
      area('Estágio em Tecnologia', 'Venha crescer conosco em um ambiente inovador.')?.outcome,
    ).toBe('indeterminado');
    expect(area('Estágio em Tecnologia', 'Apenas um chamado.')?.outcome).toBe('indeterminado');
  });

  it('título de negócio com descrição de TI vira conflito para revisão humana, nunca apto', () => {
    const description = 'Você vai trabalhar com SQL, dashboards e Power BI em análise de dados.';
    const result = area('Estágio em Operações Digital', description);
    expect(['indeterminado', 'nao_atende']).toContain(result?.outcome);
    const conflict = classifyJobAreas('Estágio em Operações Digital', description);
    expect(conflict.conflict).toBe(true);
    expect(area('Estágio em Operações Digital', description)?.outcome).toBe('indeterminado');
  });

  it('título sem área e descrição de TI: revisão, não aprovação', () => {
    const description = 'Linux, redes, servidores e virtualização no dia a dia.';
    expect(area('Programa de Estágio 2027', description)?.outcome).toBe('indeterminado');
  });

  it('o perfil pode restringir áreas, e "todas" vale para qualquer área de TI', () => {
    expect(area('Estágio em Segurança da Informação', null, ['qa'])?.outcome).toBe('nao_atende');
    expect(area('Estágio em Segurança da Informação', null, ['seguranca'])?.outcome).toBe('atende');
    expect([...canonicalProfileAreas(['todas'])].sort()).toEqual([...JOB_AREAS].sort());
    expect(
      canonicalProfileAreas(['segurança da informação', 'governança de TI', 'ERP', 'RPA', 'TI']),
    ).toEqual(
      new Set(['seguranca', 'governanca', 'sistemas-corporativos', 'automacao', 'ti-geral']),
    );
  });

  it('nomes de área desconhecidos no perfil são apontados, não aceitos em silêncio', () => {
    expect(unknownProfileAreas(['qa', 'todas', 'culinária'])).toEqual(['culinária']);
  });
});

describe('títulos de fora de TI que continham palavras ambíguas', () => {
  it.each([
    'Estagiário de Programação de Produção',
    'Estágio Atendimento a Servidores Públicos',
    'Estágio Dados Pessoais LGPD Jurídico',
    'Estágio Sistemas de Gestão da Qualidade',
    'Estágio Soc Financeiro',
    'Estágio Iam Brasil Vendas',
  ])('%s não é classificado como área de TI pelo título', (title) => {
    expect(classifyJobAreas(title, null).fromTitle).toEqual([]);
  });
});
