import { describe, expect, it } from 'vitest';
import { displayValue, planForm } from '../../src/executor/plan.js';
import type { FillAction } from '../../src/executor/types.js';
import { applicant, field, form, greenhouseLike } from './fixtures.js';

const ctx = { applicant, salary: 1800, cv: { path: '/tmp/cv.pdf', label: 'cv.pdf' } };
const plan = (fields = greenhouseLike()) => planForm(fields, ctx);
const byLabel = (p: ReturnType<typeof plan>, label: string) =>
  p.actions.find((a) => a.label === label);

describe('plano de preenchimento', () => {
  it('preenche só dados comprovados, com a origem de cada valor', () => {
    const p = plan();
    expect(byLabel(p, 'First Name')).toMatchObject({
      value: 'Pessoa',
      source: 'applicant.fullName',
      op: 'fill',
    });
    expect(byLabel(p, 'Last Name')).toMatchObject({ value: 'Exemplo da Silva' });
    expect(byLabel(p, 'Email')).toMatchObject({
      value: 'pessoa.exemplo@example.com',
      masked: true,
    });
    expect(byLabel(p, 'Phone')).toMatchObject({ value: '+55 11 99999-9999', masked: true });
    expect(byLabel(p, 'LinkedIn Profile')).toMatchObject({
      value: 'https://www.linkedin.com/in/exemplo/',
    });
    expect(byLabel(p, 'País')).toMatchObject({ op: 'select', value: 'Brasil' });
    expect(byLabel(p, 'Pretensão salarial (R$/mês)')).toMatchObject({
      value: '1800',
      source: 'politica.salaryExpectation',
    });
    expect(byLabel(p, 'Resume/CV')).toMatchObject({
      op: 'upload',
      value: '/tmp/cv.pdf',
      source: 'curriculo:cv.pdf',
    });
    expect(p.needsHuman).toEqual([]);
    expect(p.skipped.map((s) => s.label)).toContain('Cover Letter');
  });

  it('e-mail e telefone aparecem mascarados nos registros', () => {
    const email = byLabel(plan(), 'Email');
    const phone = byLabel(plan(), 'Phone');
    expect(displayValue(email as FillAction, applicant)).toBe('pe…@example.com');
    expect(displayValue(phone as FillAction, applicant)).toBe('…9999');
  });

  it('autodeclaração, aceite de termos, disponibilidade presencial e autorização nunca são preenchidos', () => {
    const p = plan(
      form([
        field({
          label: 'Gênero',
          kind: 'select',
          options: ['Feminino', 'Masculino'],
          section: 'Autodeclaração voluntária',
        }),
        field({
          label: 'Você é pessoa com deficiência?',
          kind: 'radio',
          options: ['Sim', 'Não'],
          required: true,
        }),
        field({ label: 'Li e aceito a política de privacidade', kind: 'checkbox', required: true }),
        field({
          label: 'Você tem disponibilidade para trabalhar presencialmente?',
          kind: 'radio',
          options: ['Sim', 'Não'],
          required: true,
        }),
        field({
          label: 'Você possui autorização de trabalho no Brasil?',
          kind: 'radio',
          options: ['Sim', 'Não'],
          required: true,
        }),
      ]),
    );
    expect(p.actions).toEqual([]);
    expect(p.needsHuman.map((h) => h.category)).toEqual([
      'sensivel',
      'sensivel',
      'consentimento',
      'confirmacao',
      'desconhecido',
    ]);
    expect(p.needsHuman.every((h) => h.required || h.category === 'sensivel')).toBe(true);
  });

  it('pergunta obrigatória desconhecida vira pendência; opcional fica em branco; texto livre não é escrito', () => {
    const p = plan(
      form([
        field({ label: 'Por que você quer trabalhar aqui?', kind: 'textarea', required: true }),
        field({ label: 'Qual seu nível de Kubernetes?', kind: 'text', required: true }),
        field({ label: 'Como conheceu a vaga?', kind: 'text' }),
      ]),
    );
    expect(p.actions).toEqual([]);
    expect(p.needsHuman.map((h) => h.label)).toEqual([
      'Por que você quer trabalhar aqui?',
      'Qual seu nível de Kubernetes?',
    ]);
    expect(p.skipped.map((s) => s.label)).toEqual(['Como conheceu a vaga?']);
  });

  it('não sobrescreve valor que a página já traz diferente e não preenche lista sem a opção exata', () => {
    const p = plan(
      form([
        field({ label: 'Email', kind: 'email', value: 'outro@example.com', required: true }),
        field({ label: 'País', kind: 'select', required: true, options: ['Argentina', 'Chile'] }),
        field({ label: 'Cidade', kind: 'text', value: 'São Paulo' }),
      ]),
    );
    expect(p.actions.map((a) => a.label)).toEqual(['Cidade']);
    expect(p.needsHuman.map((h) => h.label)).toEqual(['Email', 'País']);
  });

  it('sem currículo aprovado, o campo obrigatório de currículo fica para você', () => {
    const p = planForm(greenhouseLike(), { ...ctx, cv: null });
    expect(p.actions.find((a) => a.op === 'upload')).toBeUndefined();
    expect(p.needsHuman.find((h) => h.label === 'Resume/CV')?.why).toContain(
      'sem currículo aprovado',
    );
  });

  it('campos de LinkedIn/GitHub sem dado comprovado não são inventados', () => {
    const minimal = { ...ctx, applicant: { ...applicant } };
    delete (minimal.applicant as { linkedin?: string }).linkedin;
    const p = planForm(form([field({ label: 'LinkedIn', required: true })]), minimal);
    expect(p.actions).toEqual([]);
    expect(p.needsHuman).toHaveLength(1);
  });

  it('consentimento de dados em qualquer tipo de campo e perguntas de idioma ficam com você, com a dica do perfil', () => {
    const p = planForm(
      form([
        field({
          label: 'Você autoriza a empresa a utilizar seus dados pessoais?',
          kind: 'radio',
          options: ['Sim', 'Não'],
          required: true,
        }),
        field({
          label: 'Qual o seu nível de proficiência em inglês?',
          kind: 'radio',
          options: ['Básico', 'Avançado'],
          required: true,
        }),
        field({
          label: 'Qual o seu nível de proficiência em inglês?',
          kind: 'radio',
          options: ['Básico', 'Avançado'],
          required: true,
        }),
        field({
          label: 'Qual seu nível de proficiência em espanhol?',
          kind: 'radio',
          required: true,
        }),
      ]),
      {
        ...ctx,
        profile: {
          course: 'Análise e Desenvolvimento de Sistemas',
          institution: 'Uniasselvi',
          graduationYear: 2028,
          languages: [{ language: 'Inglês', level: 'intermediario', scope: 'leitura-tecnica' }],
        },
      },
    );
    expect(p.actions).toEqual([]);
    expect(p.needsHuman.map((h) => h.category)).toEqual([
      'consentimento',
      'desconhecido',
      'desconhecido',
    ]);
    expect(p.needsHuman[1]?.why).toContain('Inglês intermediario (leitura-tecnica)');
    expect(p.needsHuman[2]?.why).toContain('sem dado comprovado');
  });

  it('preenche curso, instituição e ano de conclusão com os dados do perfil aprovado', () => {
    const p = planForm(
      form([
        field({ label: 'Instituição de ensino', required: true }),
        field({ label: 'Curso', required: true }),
        field({ label: 'Ano de conclusão' }),
      ]),
      {
        ...ctx,
        profile: {
          course: 'Análise e Desenvolvimento de Sistemas',
          institution: 'Uniasselvi',
          graduationYear: 2028,
          languages: [],
        },
      },
    );
    expect(p.actions.map((a) => [a.label, a.value, a.source])).toEqual([
      ['Instituição de ensino', 'Uniasselvi', 'perfil.education.institution'],
      ['Curso', 'Análise e Desenvolvimento de Sistemas', 'perfil.education.course'],
      ['Ano de conclusão', '2028', 'perfil.education.expectedGraduationYear'],
    ]);
  });
});
