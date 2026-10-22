import { describe, expect, it } from 'vitest';
import { evaluateJob } from '../../src/eligibility/index.js';
import { NOW, find, job, profile } from '../helpers/eligibility.js';

const evaluate = (j = job(), p = profile()) => evaluateJob(p, j, { now: NOW });

describe('evaluateJob — veredito', () => {
  it('apto quando todos os requisitos obrigatórios verificáveis são atendidos', () => {
    const result = evaluate();
    expect(result.verdict).toBe('apto');
    expect(
      result.criteria.filter((c) => c.kind === 'obrigatorio').map((c) => c.outcome),
    ).not.toContain('indeterminado');
  });

  it('sem aprovação do perfil, nunca é apto nem inapto', () => {
    const unapproved = profile({ approval: undefined });
    expect(evaluate(job(), unapproved).verdict).toBe('revisao_humana');
    const bad = evaluate(job({ stipendMin: 500, stipendMax: 500 }), unapproved);
    expect(bad.verdict).toBe('revisao_humana');
    expect(bad.reasons.join(' ')).toMatch(/Perfil ainda não aprovado/);
    expect(bad.reasons.join(' ')).toMatch(/\(provisório\)/);
  });

  it('inapto pelo requisito obrigatório que não é atendido, listando os motivos', () => {
    const result = evaluate(job({ title: 'Estagiário de Marketing' }));
    expect(result.verdict).toBe('inapto');
    expect(result.reasons).toEqual(['Título indica área fora de TI.']);
  });

  it('diferenciais nunca mudam o veredito, só a contagem', () => {
    const description = 'Requisitos:\n- Cursando ADS\nDiferenciais:\n- Docker\n- Git';
    const result = evaluate(job({ description }));
    expect(result.verdict).toBe('apto');
    expect(result.differentials).toEqual({ matched: 1, total: 1 });
    expect(find(result.criteria, 'tecnologia', 'diferencial')?.detail).toMatch(/1\/2.*Git/);
  });
});

describe('área', () => {
  it.each([
    ['Estagiário de Desenvolvimento Backend', 'atende'],
    ['Estágio em QA', 'atende'],
    ['Estágio em Suporte Técnico', 'atende'],
    ['Estagiário de Infraestrutura / DevOps', 'atende'],
    ['Estagiário de Dados', 'atende'],
    ['Data Science Intern', 'atende'],
    ['Estágio em Banco de Dados', 'atende'],
    ['Estagiário Comercial', 'nao_atende'],
    ['Customer Success Intern', 'nao_atende'],
    ['Estágio em Redes Sociais', 'nao_atende'],
    ['Programa de Estágio 2027', 'indeterminado'],
    ['Estágio em TI', 'indeterminado'],
  ])('%s → %s', (title, expected) => {
    expect(find(evaluate(job({ title })).criteria, 'area')?.outcome).toBe(expected);
  });

  it('área só na descrição (não no título) vai para revisão, nunca é apta', () => {
    const result = evaluate(
      job({
        title: 'Programa de Estágio',
        description: 'Trilha de engenharia de software e dados.',
      }),
    );
    expect(find(result.criteria, 'area')?.outcome).toBe('indeterminado');
    expect(result.verdict).toBe('revisao_humana');
  });

  it('área de TI fora das áreas do perfil reprova', () => {
    const only = profile({ areas: ['qa'] });
    const result = evaluate(job({ title: 'Estágio em Infraestrutura' }), only);
    expect(find(result.criteria, 'area')?.outcome).toBe('nao_atende');
    expect(result.verdict).toBe('inapto');
  });
});

describe('bolsa', () => {
  const outcome = (min: number | null, max: number | null, extra = {}) =>
    find(evaluate(job({ stipendMin: min, stipendMax: max, ...extra })).criteria, 'bolsa')?.outcome;

  it('atende a partir de R$ 1.200 (inclusive)', () => {
    expect(outcome(1200, 1200)).toBe('atende');
    expect(outcome(1199.99, 1199.99)).toBe('nao_atende');
  });

  it('sem bolsa informada fica pendente, não descartada', () => {
    const result = evaluate(job({ stipendMin: null, stipendMax: null, stipendCurrency: null }));
    expect(find(result.criteria, 'bolsa')?.outcome).toBe('indeterminado');
    expect(result.verdict).toBe('revisao_humana');
    expect(result.reasons[0]).toMatch(/pendente de análise, não descartada/);
  });

  it('texto de bolsa sem valor mensal também é pendente, preservando o texto', () => {
    const result = evaluate(job({ stipendMin: null, stipendMax: null, stipendText: 'A combinar' }));
    expect(find(result.criteria, 'bolsa')?.detail).toMatch(/A combinar/);
  });

  it('faixa que cruza o mínimo pede confirmação; faixa toda abaixo reprova', () => {
    expect(outcome(1100, 1400)).toBe('indeterminado');
    expect(outcome(900, 1100)).toBe('nao_atende');
  });

  it('moeda diferente do mínimo do perfil é pendente', () => {
    expect(outcome(2000, 2000, { stipendCurrency: 'USD' })).toBe('indeterminado');
  });
});

describe('modalidade, local e deslocamento', () => {
  const run = (overrides: Parameters<typeof job>[0], p = profile()) => evaluate(job(overrides), p);

  it('remoto no Brasil (ou sem local) atende, sem exigir deslocamento', () => {
    const result = run({ workMode: 'remoto', location: 'Remote - Brazil' });
    expect(find(result.criteria, 'localizacao')?.outcome).toBe('atende');
    expect(find(result.criteria, 'deslocamento')).toBeUndefined();
    expect(result.verdict).toBe('apto');
    expect(run({ workMode: 'remoto', location: null }).verdict).toBe('apto');
  });

  it('remoto restrito a outro país não é presumido: revisão', () => {
    const result = run({ workMode: 'remoto', location: 'Remote - US' });
    expect(find(result.criteria, 'localizacao')?.outcome).toBe('indeterminado');
  });

  it('modalidade desconhecida nunca é presumida', () => {
    const result = run({ workMode: null });
    expect(find(result.criteria, 'modalidade')?.outcome).toBe('indeterminado');
    expect(result.verdict).toBe('revisao_humana');
  });

  it('presencial em São Paulo com deslocamento verificado dentro de 70 min atende', () => {
    const result = run({ workMode: 'presencial' });
    expect(find(result.criteria, 'deslocamento')).toMatchObject({ outcome: 'atende' });
    expect(find(result.criteria, 'deslocamento')?.detail).toMatch(/45 min/);
    expect(result.verdict).toBe('apto');
  });

  it('deslocamento acima de 70 min reprova', () => {
    const slow = profile({
      commute: [{ keywords: ['pinheiros'], minutesPerWay: 71, source: 'teste' }],
    });
    const result = run({ workMode: 'presencial' }, slow);
    expect(find(result.criteria, 'deslocamento')?.outcome).toBe('nao_atende');
    expect(result.verdict).toBe('inapto');
  });

  it('70 min exatos ainda atende', () => {
    const edge = profile({
      commute: [{ keywords: ['pinheiros'], minutesPerWay: 70, source: 'teste' }],
    });
    expect(find(run({}, edge).criteria, 'deslocamento')?.outcome).toBe('atende');
  });

  it('local não listado no perfil = deslocamento não verificável: revisão, sem inventar tempo', () => {
    const result = run({ location: 'São Paulo - Itaim Bibi' });
    expect(find(result.criteria, 'deslocamento')?.outcome).toBe('indeterminado');
    expect(result.verdict).toBe('revisao_humana');
  });

  it('sem nenhum tempo verificado no perfil, híbrido/presencial vai para revisão', () => {
    const none = profile({ commute: undefined });
    expect(run({}, none).verdict).toBe('revisao_humana');
  });

  it('usa o pior tempo quando mais de um local casa', () => {
    const two = profile({
      commute: [
        { keywords: ['pinheiros'], minutesPerWay: 40, source: 'a' },
        { keywords: ['empresa exemplo'], minutesPerWay: 90, source: 'b' },
      ],
    });
    expect(find(run({}, two).criteria, 'deslocamento')?.outcome).toBe('nao_atende');
  });

  it('híbrido ou presencial em outra cidade reprova; cidade ambígua vai para revisão', () => {
    expect(find(run({ location: 'Campinas, SP' }).criteria, 'localizacao')?.outcome).toBe(
      'nao_atende',
    );
    expect(find(run({ location: 'Rio de Janeiro' }).criteria, 'localizacao')?.outcome).toBe(
      'nao_atende',
    );
    expect(find(run({ location: 'Escritório central' }).criteria, 'localizacao')?.outcome).toBe(
      'indeterminado',
    );
  });

  it('presencial não aceito pelo perfil reprova na modalidade', () => {
    const noOnsite = profile({
      workModes: { preferred: ['remoto'], onsite: { allowed: false, maxCommuteMinutesPerWay: 70 } },
    });
    const result = run({ workMode: 'presencial' }, noOnsite);
    expect(find(result.criteria, 'modalidade')?.outcome).toBe('nao_atende');
    expect(result.verdict).toBe('inapto');
  });
});

describe('curso, semestre e formatura', () => {
  const withDescription = (description: string, p = profile()) => evaluate(job({ description }), p);

  it('curso citado igual ao do perfil, ou "áreas afins" de computação, atende', () => {
    expect(
      find(
        withDescription('Requisitos: cursando Análise e Desenvolvimento de Sistemas.').criteria,
        'curso',
      )?.outcome,
    ).toBe('atende');
    expect(
      find(
        withDescription('Requisitos: cursando Ciência da Computação ou áreas afins.').criteria,
        'curso',
      )?.outcome,
    ).toBe('atende');
  });

  it('curso diferente sem "afins" não reprova sozinho: revisão', () => {
    const result = withDescription('Requisitos: cursando Engenharia da Computação.');
    expect(find(result.criteria, 'curso')?.outcome).toBe('indeterminado');
    expect(result.verdict).toBe('revisao_humana');
  });

  it('exigir pós-graduação reprova; só "ensino superior" atende', () => {
    expect(withDescription('Requisitos: cursando mestrado em computação.').verdict).toBe('inapto');
    expect(
      find(withDescription('Requisitos: estudante de ensino superior.').criteria, 'curso')?.outcome,
    ).toBe('atende');
  });

  it('semestre: dentro da faixa atende, fora reprova, desconhecido vai para revisão', () => {
    const text = 'Cursando entre o 2º e o 5º semestre.';
    expect(find(withDescription(text).criteria, 'semestre')?.outcome).toBe('atende');
    expect(
      find(withDescription('Cursando a partir do 5º semestre.').criteria, 'semestre')?.outcome,
    ).toBe('nao_atende');
    expect(find(withDescription('Cursando até o 2º semestre.').criteria, 'semestre')?.outcome).toBe(
      'nao_atende',
    );
    const unknown = profile({ education: { ...profile().education, currentSemester: undefined } });
    const result = withDescription(text, unknown);
    expect(find(result.criteria, 'semestre')?.outcome).toBe('indeterminado');
    expect(result.verdict).toBe('revisao_humana');
  });

  it('formatura: faixa, "até" e "a partir de" comparados ao ano previsto do perfil', () => {
    const outcome = (text: string) => find(withDescription(text).criteria, 'formatura')?.outcome;
    expect(outcome('Previsão de formatura entre 2027 e 2029.')).toBe('atende');
    expect(outcome('Previsão de formatura entre 2026 e 2027.')).toBe('nao_atende');
    expect(outcome('Conclusão do curso até 2027.')).toBe('nao_atende');
    expect(outcome('Formatura a partir de 2028.')).toBe('atende');
    expect(outcome('Formatura em 2028.')).toBe('atende');
  });
});

describe('idioma', () => {
  const lang = (description: string, p = profile()) =>
    find(evaluate(job({ description }), p).criteria, 'idioma');

  it('inglês avançado em "Requisitos" reprova um perfil intermediário (obrigatório)', () => {
    const result = evaluate(job({ description: 'Requisitos:\n- Inglês avançado' }));
    expect(find(result.criteria, 'idioma')).toMatchObject({
      kind: 'obrigatorio',
      outcome: 'nao_atende',
    });
    expect(result.verdict).toBe('inapto');
  });

  it('o mesmo requisito em "Diferenciais" não reprova', () => {
    const result = evaluate(job({ description: 'Diferenciais:\n- Inglês avançado' }));
    expect(find(result.criteria, 'idioma', 'diferencial')?.outcome).toBe('nao_atende');
    expect(result.verdict).toBe('apto');
  });

  it('nível exigido ≤ nível do perfil atende', () => {
    expect(lang('Requisitos: inglês intermediário.')?.outcome).toBe('atende');
  });

  it('"intermediário ou avançado" exige o menor nível citado', () => {
    expect(lang('Requisitos: inglês intermediário ou avançado.')?.outcome).toBe('atende');
  });

  it('perfil sem nível de idioma nunca é presumido: revisão', () => {
    const none = profile({ languages: undefined });
    const result = evaluate(job({ description: 'Requisitos: inglês intermediário.' }), none);
    expect(find(result.criteria, 'idioma')?.outcome).toBe('indeterminado');
    expect(result.verdict).toBe('revisao_humana');
  });

  it('idioma sem nível na vaga: atende só se o perfil for ao menos intermediário', () => {
    expect(lang('Requisitos: inglês.')?.outcome).toBe('atende');
    const basic = profile({ languages: [{ language: 'Inglês', level: 'basico' }] });
    expect(lang('Requisitos: inglês.', basic)?.outcome).toBe('indeterminado');
  });

  it('menção fora de requisitos (sem seção) nunca reprova sozinha', () => {
    const result = evaluate(
      job({ description: 'Buscamos pessoa com inglês fluente para o time.' }),
    );
    expect(find(result.criteria, 'idioma')?.outcome).toBe('indeterminado');
    expect(result.verdict).toBe('revisao_humana');
  });

  it('benefícios e "inglês não é obrigatório" são ignorados', () => {
    expect(lang('Benefícios:\n- Aulas de inglês')).toBeUndefined();
    expect(lang('Inglês não é obrigatório.')).toBeUndefined();
    expect(lang('Requisitos: curso de inglês pago pela empresa.')).toBeUndefined();
  });
});

describe('disponibilidade', () => {
  const run = (description: string, p = profile()) => evaluate(job({ description }), p);

  it('carga horária semanal ou diária comparada à disponibilidade do perfil', () => {
    expect(
      find(run('Carga horária de 30 horas semanais.').criteria, 'carga-horaria')?.outcome,
    ).toBe('atende');
    expect(find(run('Jornada de 6h por dia.').criteria, 'carga-horaria')?.outcome).toBe('atende');
    expect(find(run('Jornada de 40 horas semanais.').criteria, 'carga-horaria')?.outcome).toBe(
      'nao_atende',
    );
    expect(find(run('Entre 25 e 35 horas semanais.').criteria, 'carga-horaria')?.outcome).toBe(
      'atende',
    );
  });

  it('sem disponibilidade no perfil: revisão', () => {
    const none = profile({ availability: undefined });
    const result = run('Carga horária de 30 horas semanais.', none);
    expect(find(result.criteria, 'carga-horaria')?.outcome).toBe('indeterminado');
    expect(result.verdict).toBe('revisao_humana');
  });

  it('início: mês/ano comparado à data em que o perfil pode começar', () => {
    expect(find(run('Início em janeiro de 2027.').criteria, 'inicio')?.outcome).toBe('atende');
    expect(find(run('Início em novembro de 2026.').criteria, 'inicio')?.outcome).toBe('nao_atende');
    expect(find(run('Início em janeiro.').criteria, 'inicio')?.outcome).toBe('indeterminado');
  });

  it('início imediato usa o relógio injetado', () => {
    expect(find(run('Início imediato.').criteria, 'inicio')?.outcome).toBe('nao_atende'); // startFrom 2026-12-01
    const soon = profile({
      availability: { hoursPerWeek: { min: 20, max: 30 }, startFrom: '2026-10-01' },
    });
    expect(find(run('Início imediato.', soon).criteria, 'inicio')?.outcome).toBe('atende');
  });
});

describe('tecnologias', () => {
  const tech = (description: string, kind: 'obrigatorio' | 'diferencial' = 'obrigatorio') =>
    find(evaluate(job({ description })).criteria, 'tecnologia', kind);

  it('exigida e presente no perfil atende', () => {
    expect(tech('Requisitos:\n- TypeScript\n- SQL')?.outcome).toBe('atende');
  });

  it('exigida e ausente do perfil não é presumida: revisão, listando o que falta', () => {
    const result = evaluate(job({ description: 'Requisitos:\n- Python\n- SQL' }));
    expect(find(result.criteria, 'tecnologia')?.outcome).toBe('indeterminado');
    expect(find(result.criteria, 'tecnologia')?.detail).toMatch(/Python/);
    expect(result.verdict).toBe('revisao_humana');
  });

  it('tecnologia em responsabilidades ou sem contexto não vira requisito', () => {
    expect(tech('Atividades:\n- Desenvolver em Python')).toBeUndefined();
    expect(tech('Você vai usar Python no dia a dia.')).toBeUndefined();
  });

  it('"obrigatório" no próprio trecho torna a tecnologia exigida', () => {
    expect(tech('Python é obrigatório.')?.outcome).toBe('indeterminado');
  });

  it('diferenciais só contam, sem reprovar', () => {
    const result = evaluate(job({ description: 'Desejável: Python e Docker.' }));
    expect(find(result.criteria, 'tecnologia', 'diferencial')?.outcome).toBe('nao_atende');
    expect(result.verdict).toBe('apto');
  });
});

describe('segmentação (obrigatório × diferencial)', () => {
  it('cabeçalho com texto na mesma linha vale para o conteúdo e para as linhas seguintes', async () => {
    const { segmentDescription } = await import('../../src/eligibility/index.js');
    const segments = segmentDescription(
      'Requisitos: TypeScript\n- SQL\nDiferenciais:\n- Docker\nBenefícios:\n- VR',
    );
    expect(segments.map((s) => [s.text, s.context])).toEqual([
      ['TypeScript', 'requisito'],
      ['SQL', 'requisito'],
      ['Docker', 'diferencial'],
      ['VR', 'outro'],
    ]);
  });

  it('marcadores na própria frase vencem a seção', async () => {
    const { segmentDescription } = await import('../../src/eligibility/index.js');
    const [a, b] = segmentDescription(
      'Requisitos:\n- Docker é um diferencial\nDiferenciais:\n- Git é obrigatório',
    );
    expect(a?.context).toBe('diferencial');
    expect(b?.context).toBe('requisito');
  });
});
