import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  CvParseError,
  extractPdf,
  extractPdfBytes,
  joinLines,
  modelHash,
  parseMaster,
  slugify,
  splitList,
  cvMasterSchema,
  type PdfExtraction,
} from '../../src/cv/index.js';
import { FICTIONAL_LINKS, makeFictionalMasterPdf } from '../helpers/master-pdf.js';

let bytes: Buffer;
let extraction: PdfExtraction;
beforeAll(async () => {
  bytes = await makeFictionalMasterPdf();
  extraction = await extractPdfBytes(bytes, 'mestre-ficticio.pdf');
});

describe('extração do PDF (somente leitura)', () => {
  it('devolve SHA-256, páginas, linhas com fonte/posição e os links com o texto visível', () => {
    expect(extraction.sha256).toBe(createHash('sha256').update(bytes).digest('hex'));
    expect(extraction.pages).toBe(1);
    expect(extraction.label).toBe('mestre-ficticio.pdf');
    expect(extraction.lines[0]).toMatchObject({
      text: 'MARIA EXEMPLO DA SILVA',
      startsBold: true,
      allBold: true,
    });
    expect(extraction.lines.find((l) => l.text.startsWith('•'))).toMatchObject({
      startsBold: false,
    });
    expect(extraction.links.map((l) => [l.label, l.url])).toEqual([
      ['LinkedIn', FICTIONAL_LINKS.linkedin],
      ['GitHub', FICTIONAL_LINKS.github],
      ['Portfólio', FICTIONAL_LINKS.portfolio],
      ['Demo', FICTIONAL_LINKS.jfqDemo],
      ['GitHub', FICTIONAL_LINKS.jfqRepo],
      ['Demo', FICTIONAL_LINKS.agendaDemo],
      ['GitHub', FICTIONAL_LINKS.agendaRepo],
      ['GitHub', FICTIONAL_LINKS.notasRepo],
    ]);
  });

  describe('arquivo no disco', () => {
    const dirs: string[] = [];
    afterEach(() => {
      for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
    });

    it('não modifica o PDF: mesmo SHA-256, tamanho e data de modificação', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'cv-'));
      dirs.push(dir);
      const file = join(dir, 'mestre.pdf');
      writeFileSync(file, bytes, { mode: 0o444 });
      const before = {
        sha: createHash('sha256').update(readFileSync(file)).digest('hex'),
        mtime: statSync(file).mtimeMs,
        size: statSync(file).size,
      };
      const result = await extractPdf(file);
      expect(result.sha256).toBe(before.sha);
      const after = statSync(file);
      expect([
        after.mtimeMs,
        after.size,
        createHash('sha256').update(readFileSync(file)).digest('hex'),
      ]).toEqual([before.mtime, before.size, before.sha]);
    });
  });
});

describe('utilidades de texto', () => {
  it('joinLines une palavra composta quebrada no hífen sem espaço', () => {
    const line = (text: string) => ({
      n: 1,
      page: 1,
      y: 0,
      x: 0,
      size: 9,
      startsBold: false,
      allBold: false,
      text,
    });
    expect(joinLines([line('plataforma e-'), line('commerce, usada')])).toBe(
      'plataforma e-commerce, usada',
    );
    expect(joinLines([line('com estabilidade'), line('contínua')])).toBe(
      'com estabilidade contínua',
    );
    expect(joinLines([line('abc -'), line('def')])).toBe('abc - def'); // hífen solto não cola
  });

  it('splitList respeita parênteses e slugify gera ids estáveis', () => {
    expect(splitList('JavaScript (ES6+), Playwright (E2E, CI), SQL')).toEqual([
      'JavaScript (ES6+)',
      'Playwright (E2E, CI)',
      'SQL',
    ]);
    expect(slugify('Oficina Exemplo Ltda.')).toBe('oficina-exemplo-ltda');
    expect(slugify('Garantia+')).toBe('garantia');
    expect(slugify('é')).toBe('xe');
  });
});

describe('parseMaster', () => {
  const parsed = () => parseMaster(extraction, { now: new Date('2026-10-22T12:00:00Z') });

  it('estrutura identidade, resumo, experiências, projetos, skills, formação, idiomas e certificações', () => {
    const { model, notes } = parsed();
    expect(notes).toEqual([]);
    expect(model.master).toMatchObject({
      sha256: extraction.sha256,
      label: 'mestre-ficticio.pdf',
      pages: 1,
      extractedAt: '2026-10-22',
    });
    expect(model.identity.name.value).toBe('MARIA EXEMPLO DA SILVA');
    expect(model.identity.location.value).toBe('São Paulo, SP');
    expect(model.identity.contacts.map((c) => [c.kind, c.value])).toEqual([
      ['telefone', '(11) 90000-0000'],
      ['email', 'maria.exemplo@example.com'],
    ]);
    expect(model.identity.links.map((l) => l.label)).toEqual(['LinkedIn', 'GitHub', 'Portfólio']);
    expect(model.summary.variants[0]?.text).toMatch(
      /^Desenvolvedora Full Stack com três sistemas.*Estudante de Análise e Desenvolvimento de Sistemas\.$/,
    );

    expect(model.experience.map((e) => [e.id, e.period?.label, e.bullets.length])).toEqual([
      ['exp-oficina-exemplo-ltda', '2026', 2],
      ['exp-agendamais', '2025 – 2026', 2],
    ]);
    expect(model.experience[1]?.period).toEqual({
      label: '2025 – 2026',
      start: '2025',
      end: '2026',
    });
    expect(model.projects.map((p) => [p.id, p.period])).toEqual([['proj-notasfacil', undefined]]);
    expect(model.experience[0]).toMatchObject({
      organization: 'Oficina Exemplo Ltda.',
      role: 'Desenvolvedora Full Stack (projeto para empresa real)',
      technologies: ['React', 'Node.js', 'PostgreSQL', 'Prisma ORM'],
    });
    expect(model.experience[0]?.links.map((l) => [l.label, l.url])).toEqual([
      ['Demo', FICTIONAL_LINKS.jfqDemo],
      ['GitHub', FICTIONAL_LINKS.jfqRepo],
    ]);
    expect(model.skills.map((s) => [s.category, s.items.length])).toEqual([
      ['Linguagens', 3],
      ['Testes', 3],
    ]);
    expect(model.skills[1]?.items).toEqual([
      'Vitest',
      'Playwright (E2E, CI)',
      'testes de integração',
    ]);
    expect(model.education.map((e) => [e.course, e.institution, e.status])).toEqual([
      ['Análise e Desenvolvimento de Sistemas', 'Faculdade Exemplo', 'cursando'],
      [
        'Ensino Médio Técnico em Desenvolvimento de Sistemas',
        'Escola Técnica Exemplo',
        'concluido',
      ],
    ]);
    expect(model.languages).toHaveLength(1);
    expect(model.certifications[0]).toMatchObject({
      title: 'Fundamentos de APIs REST',
      issuer: 'Instituto Exemplo',
      year: 2026,
      description: 'conceitos e boas práticas de integração.',
    });
  });

  it('une bullets que quebram linha, inclusive em hífen (e-commerce) e em vírgula', () => {
    const { model } = parsed();
    const bullet = model.experience[0]?.bullets[0]?.variants[0]?.text;
    expect(bullet).toBe(
      'Desenvolvi e mantenho em produção uma plataforma comercial com painel administrativo, ordens de serviço e e-commerce, usada em média por 40 pessoas e gerando vendas recorrentes todos os meses.',
    );
  });

  it('cada texto traz a origem: seção, página, linhas e SHA-256 do texto', () => {
    const { model } = parsed();
    const variant = model.experience[0]?.bullets[0]?.variants[0];
    expect(variant?.origin).toBe('mestre');
    expect(variant?.sourceRef).toMatchObject({ section: 'experiencia', page: 1, lines: [10, 11] });
    expect(variant?.sourceRef.textSha256).toBe(
      createHash('sha256')
        .update(variant?.text ?? '')
        .digest('hex'),
    );
    // as linhas apontadas realmente contêm o início do texto
    const [from] = variant?.sourceRef.lines ?? [0, 0];
    expect(extraction.lines[from - 1]?.text).toContain('Desenvolvi e mantenho');
  });

  it('NADA nasce aprovado: rascunho, sem approvedAt, links não confirmados, sem aprovação do modelo', () => {
    const { model } = parsed();
    const blocks = [
      model.identity.headline,
      model.summary,
      ...model.experience.flatMap((e) => e.bullets),
      ...model.projects.flatMap((e) => e.bullets),
    ];
    for (const v of blocks.flatMap((b) => b.variants)) {
      expect(v.status).toBe('rascunho');
      expect(v.approvedAt).toBeUndefined();
    }
    const links = [
      ...model.identity.links,
      ...model.experience.flatMap((e) => e.links),
      ...model.projects.flatMap((e) => e.links),
    ];
    expect(links).toHaveLength(8);
    for (const l of links) expect(l).toMatchObject({ confirmedByUser: false, status: 'rascunho' });
    expect(links.every((l) => l.approvedAt === undefined)).toBe(true);
    expect(model.approval).toBeUndefined();
    expect(model.proposals).toEqual({ items: [], notProposed: [] });
    expect(JSON.stringify(model)).not.toContain('"aprovado"');
  });

  it('é determinístico: mesma entrada, mesmo modelo e mesmo hash', () => {
    expect(modelHash(parsed().model)).toBe(modelHash(parsed().model));
    expect(parsed().model).toEqual(parsed().model);
  });

  it('falha explicitamente (sem descartar nada em silêncio) diante de estrutura desconhecida', async () => {
    const weird = await extractPdfBytes(
      await makeFictionalMasterPdf({ extraHeading: 'SEÇÃO NOVA E ESTRANHA' }),
      'x.pdf',
    );
    expect(() => parseMaster(weird)).toThrow(/título de seção desconhecido/);
    const noContact = await extractPdfBytes(
      await makeFictionalMasterPdf({
        mutate: (l) => {
          l[2] = { text: 'sem e-mail aqui', style: 'contact' };
        },
      }),
      'x.pdf',
    );
    expect(() => parseMaster(noContact)).toThrow(CvParseError);
    const badSkill = await extractPdfBytes(
      await makeFictionalMasterPdf({
        mutate: (l) => {
          l.splice(27, 0, { text: 'linha sem dois pontos', style: 'skill' });
        },
      }),
      'x.pdf',
    );
    expect(() => parseMaster(badSkill)).toThrow(/competências|não reconhecida|fora do formato/);
  });

  it('o esquema recusa aprovação inconsistente e aprovação do modelo com blocos em rascunho', () => {
    const { model } = parsed();
    const approvedWithoutDate = structuredClone(model);
    const variant = approvedWithoutDate.summary.variants[0];
    if (variant === undefined) throw new Error('sem variante');
    variant.status = 'aprovado';
    expect(cvMasterSchema.safeParse(approvedWithoutDate).success).toBe(false);

    const modelApproval = {
      ...structuredClone(model),
      approval: { approvedAt: '2026-10-22', modelHash: modelHash(model) },
    };
    const result = cvMasterSchema.safeParse(modelApproval);
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toMatch(/todos os blocos aprovados/);

    const dateWithoutStatus = structuredClone(model);
    const v2 = dateWithoutStatus.summary.variants[0];
    if (v2 === undefined) throw new Error('sem variante');
    v2.approvedAt = '2026-10-22';
    expect(cvMasterSchema.safeParse(dateWithoutStatus).success).toBe(false);
  });

  it('ids únicos em todo o modelo', () => {
    const { model } = parsed();
    const dup = structuredClone(model);
    const second = dup.experience[1];
    const first = dup.experience[0];
    if (second === undefined || first === undefined) throw new Error('faltam entradas');
    second.id = first.id;
    expect(JSON.stringify(cvMasterSchema.safeParse(dup).error?.issues)).toMatch(/id repetido/);
  });
});
