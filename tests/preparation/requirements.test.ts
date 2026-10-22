import { describe, expect, it } from 'vitest';
import { answerQuestion, detectRequirements } from '../../src/preparation/index.js';
import { profile } from '../helpers/eligibility.js';

const keys = (
  description: string | null,
  extra: Partial<Parameters<typeof detectRequirements>[0]> = {},
) =>
  detectRequirements({
    description,
    channel: 'manual',
    verdict: 'apto',
    eligibility: [],
    ...extra,
  }).map((s) => s.key);

describe('detectRequirements', () => {
  it('canal: ausente, e-mail e portal geram pendências bloqueantes; manual não', () => {
    const spec = (channel: 'email' | 'portal' | 'manual' | null) =>
      detectRequirements({ description: null, channel, verdict: 'apto', eligibility: [] });
    expect(spec(null).map((s) => s.key)).toEqual(['canal']);
    expect(spec('email')[0]).toMatchObject({ key: 'destinatario_verificado', blocking: true });
    expect(spec('portal')[0]).toMatchObject({ key: 'formulario_portal', kind: 'pergunta' });
    expect(spec('manual')).toEqual([]);
  });

  it('pedidos explícitos da vaga que o perfil não cobre viram pendência', () => {
    expect(
      keys(
        'Envie o link do seu GitHub e do LinkedIn. Informe sua pretensão salarial. Anexe o histórico escolar.',
      ),
    ).toEqual(['pretensao_salarial', 'link_github', 'link_linkedin', 'historico_escolar']);
    expect(keys('Informe seu CPF e RG.')).toEqual(['documentos_pessoais']);
  });

  it('menção solta, sem pedido ao candidato, não gera pendência', () => {
    expect(keys('Nosso time usa GitHub e fala sobre portfólio de produtos.')).toEqual([]);
  });

  it('carta de apresentação e teste técnico são só avisos (não bloqueiam)', () => {
    const specs = detectRequirements({
      description: 'Há carta de apresentação e um desafio técnico.',
      channel: 'manual',
      verdict: 'apto',
      eligibility: [],
    });
    expect(specs.map((s) => [s.key, s.blocking])).toEqual([
      ['carta_apresentacao', false],
      ['teste_tecnico', false],
    ]);
  });

  it('vaga em revisão humana leva as indeterminações de elegibilidade como pendências bloqueantes', () => {
    const specs = detectRequirements({
      description: null,
      channel: 'manual',
      verdict: 'revisao_humana',
      eligibility: [
        {
          id: 'bolsa',
          kind: 'obrigatorio',
          outcome: 'indeterminado',
          detail: 'Bolsa não informada.',
        },
        {
          id: 'deslocamento',
          kind: 'obrigatorio',
          outcome: 'indeterminado',
          detail: 'Não verificável.',
        },
        { id: 'area', kind: 'obrigatorio', outcome: 'atende', detail: 'ok' },
        { id: 'perfil', kind: 'obrigatorio', outcome: 'indeterminado', detail: 'x' },
        { id: 'tecnologia', kind: 'diferencial', outcome: 'indeterminado', detail: 'x' },
      ],
    });
    expect(specs.map((s) => [s.key, s.blocking])).toEqual([
      ['elegibilidade:bolsa', true],
      ['elegibilidade:deslocamento', true],
    ]);
    expect(keys(null, { verdict: 'apto' })).toEqual([]);
  });
});

describe('answerQuestion — só responde o que o perfil aprovado sabe', () => {
  const p = profile({ education: { ...profile().education, expectedGraduationMonth: 6 } });
  const ask = (q: string) => answerQuestion(p, q).answer;

  it.each([
    ['Nome completo', 'Pessoa Exemplo'],
    ['Qual é o seu nome?', 'Pessoa Exemplo'],
    ['Cidade', 'São Paulo, SP'],
    ['Curso', 'Análise e Desenvolvimento de Sistemas'],
    ['Instituição de ensino', 'Faculdade Exemplo'],
    ['Semestre atual', '3º semestre'],
    ['Previsão de conclusão', '06/2028'],
    ['Disponibilidade semanal', '20 a 30 horas semanais'],
  ])('%s → %s', (question, expected) => {
    expect(ask(question)).toBe(expected);
  });

  it('inglês respeita o escopo do perfil', () => {
    const reading = profile({
      languages: [{ language: 'Inglês', level: 'intermediario', scope: 'leitura-tecnica' }],
    });
    expect(answerQuestion(reading, 'Nível de inglês').answer).toMatch(
      /apenas leitura técnica.*conversação não comprovada/,
    );
    expect(
      answerQuestion(profile({ languages: undefined }), 'Nível de inglês').answer,
    ).toBeUndefined();
  });

  it.each([
    'Qual sua pretensão salarial?',
    'CPF',
    'Data de nascimento',
    'Gênero',
    'Você possui alguma deficiência?',
    'Telefone',
    'Link do GitHub',
    'Quantos anos de experiência você tem?',
    'Você tem certificação AWS?',
    'Por que você quer trabalhar aqui?',
    'Nome da empresa onde trabalha atualmente',
    'Curso de inglês que você já fez',
  ])('pergunta desconhecida ou sensível fica pendente: %s', (question) => {
    expect(ask(question)).toBeUndefined();
  });

  it('dado ausente no perfil nunca vira resposta', () => {
    const bare = profile({
      availability: undefined,
      education: { ...profile().education, currentSemester: undefined },
    });
    expect(answerQuestion(bare, 'Semestre atual').answer).toBeUndefined();
    expect(answerQuestion(bare, 'Disponibilidade semanal').answer).toBeUndefined();
  });
});
