import PDFDocument from 'pdfkit';

/**
 * Gera um currículo mestre FICTÍCIO (Maria Exemplo) no mesmo formato do currículo real: título em
 * negrito com período, bullets "•" que quebram linha (inclusive em hífen), linha "Tecnologias: … |
 * Links: …", skills "Categoria: itens", educação e idiomas/certificações. Links são anotações.
 */
export interface FictionalOptions {
  /** Muda um texto para testar detecção de divergência. */
  mutate?: (lines: Line[]) => void;
  /** Acrescenta uma seção desconhecida (a leitura deve falhar). */
  extraHeading?: string;
}

export interface Line {
  text: string;
  /** 'h' título de seção, 'b' negrito, 'r' regular */
  style:
    | 'name'
    | 'headline'
    | 'contact'
    | 'h'
    | 'title'
    | 'bullet'
    | 'cont'
    | 'tech'
    | 'skill'
    | 'plain'
    | 'plainbold';
  links?: { label: string; url: string }[];
}

export const FICTIONAL_LINKS = {
  linkedin: 'https://www.example.com/in/maria-exemplo-',
  github: 'https://www.example.com/maria-exemplo',
  portfolio: 'https://maria-exemplo.example.com/',
  jfqDemo: 'https://oficina-exemplo.example.com/',
  jfqRepo: 'https://www.example.com/maria-exemplo/oficina-',
  agendaDemo: 'https://agenda-exemplo.example.com/',
  agendaRepo: 'https://www.example.com/maria-exemplo/agenda',
  notasRepo: 'https://www.example.com/maria-exemplo/notas',
};

export function fictionalLines(): Line[] {
  return [
    { text: 'MARIA EXEMPLO DA SILVA', style: 'name' },
    {
      text: 'Estágio em Tecnologia da Informação (TI) — Desenvolvedora Full Stack',
      style: 'headline',
    },
    {
      text: 'São Paulo, SP | (11) 90000-0000 | maria.exemplo@example.com | LinkedIn | GitHub | Portfólio',
      style: 'contact',
      links: [
        { label: 'LinkedIn', url: FICTIONAL_LINKS.linkedin },
        { label: 'GitHub', url: FICTIONAL_LINKS.github },
        { label: 'Portfólio', url: FICTIONAL_LINKS.portfolio },
      ],
    },
    { text: 'RESUMO PROFISSIONAL', style: 'h' },
    {
      text: 'Desenvolvedora Full Stack com três sistemas fictícios em produção usados por cerca de 90 pessoas, incluindo uma plataforma comercial que',
      style: 'plain',
    },
    {
      text: 'gera vendas reais para uma oficina. Experiência com SaaS multi-empresa, testes automatizados e segurança, usando React e PostgreSQL.',
      style: 'plain',
    },
    { text: 'Estudante de Análise e Desenvolvimento de Sistemas.', style: 'plain' },
    { text: 'EXPERIÊNCIA PROFISSIONAL', style: 'h' },
    {
      text: 'Oficina Exemplo Ltda. — Desenvolvedora Full Stack (projeto para empresa real) | 2026',
      style: 'title',
    },
    {
      text: '• Desenvolvi e mantenho em produção uma plataforma comercial com painel administrativo, ordens de serviço e e-',
      style: 'bullet',
    },
    {
      text: 'commerce, usada em média por 40 pessoas e gerando vendas recorrentes todos os meses.',
      style: 'cont',
    },
    {
      text: '• Implementei autenticação JWT, webhooks, validação HMAC e camadas de segurança (Helmet, CSP); deploy em produção na Vercel,',
      style: 'bullet',
    },
    { text: 'com estabilidade contínua para clientes reais.', style: 'cont' },
    {
      text: 'Tecnologias: React, Node.js, PostgreSQL, Prisma ORM | Links: Demo | GitHub',
      style: 'tech',
      links: [
        { label: 'Demo', url: FICTIONAL_LINKS.jfqDemo },
        { label: 'GitHub', url: FICTIONAL_LINKS.jfqRepo },
      ],
    },
    { text: 'AgendaMais — SaaS de Agendamento (projeto autoral) | 2025 – 2026', style: 'title' },
    {
      text: '• Desenvolvi uma plataforma multi-empresa, usada em média por 50 pessoas, para gestão de agenda e horários livres por fuso horário.',
      style: 'bullet',
    },
    {
      text: '• Impedi agendamentos sobrepostos com exclusion constraint no PostgreSQL; testes de concorrência e isolamento com PostgreSQL real.',
      style: 'bullet',
    },
    {
      text: 'Tecnologias: TypeScript, React, PostgreSQL, Docker | Links: Demo | GitHub',
      style: 'tech',
      links: [
        { label: 'Demo', url: FICTIONAL_LINKS.agendaDemo },
        { label: 'GitHub', url: FICTIONAL_LINKS.agendaRepo },
      ],
    },
    { text: 'PROJETOS DE DESTAQUE', style: 'h' },
    { text: 'NotasFácil — Plataforma de Gestão de Compras e Garantias', style: 'title' },
    {
      text: '• Aplicação Full Stack para centralizar compras e garantias, com autenticação JWT e IA para extração de dados de notas.',
      style: 'bullet',
    },
    {
      text: '• Garanti a confiabilidade com mais de 600 testes automatizados (300 no frontend e 300 no backend), cobrindo componentes e rotas de API.',
      style: 'bullet',
    },
    {
      text: 'Tecnologias: TypeScript, React, Node.js, PostgreSQL, IA | Links: GitHub',
      style: 'tech',
      links: [{ label: 'GitHub', url: FICTIONAL_LINKS.notasRepo }],
    },
    { text: 'COMPETÊNCIAS TÉCNICAS (SKILLS)', style: 'h' },
    { text: 'Linguagens: JavaScript (ES6+), TypeScript, SQL', style: 'skill' },
    { text: 'Testes: Vitest, Playwright (E2E, CI), testes de integração', style: 'skill' },
    { text: 'EDUCAÇÃO', style: 'h' },
    {
      text: 'Análise e Desenvolvimento de Sistemas — Faculdade Exemplo | Cursando, previsão de conclusão em 2028',
      style: 'skill',
    },
    {
      text: 'Ensino Médio Técnico em Desenvolvimento de Sistemas — Escola Técnica Exemplo | Concluído em 2025',
      style: 'skill',
    },
    { text: 'IDIOMAS E CERTIFICAÇÕES', style: 'h' },
    {
      text: 'Português: Nativo | Inglês: Intermediário (leitura técnica e documentação)',
      style: 'skill',
    },
    {
      text: 'Fundamentos de APIs REST — Instituto Exemplo (2026): conceitos e boas práticas de integração.',
      style: 'skill',
    },
  ];
}

export async function makeFictionalMasterPdf(options: FictionalOptions = {}): Promise<Buffer> {
  const lines = fictionalLines();
  if (options.extraHeading !== undefined)
    lines.push({ text: options.extraHeading, style: 'h' }, { text: 'Conteúdo', style: 'plain' });
  options.mutate?.(lines);

  const doc = new PDFDocument({
    size: 'LETTER',
    margins: { top: 36, left: 36, right: 36, bottom: 36 },
    info: { CreationDate: new Date('2026-10-22T12:00:00Z') },
  });
  const chunks: Buffer[] = [];
  doc.on('data', (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((resolve) =>
    doc.on('end', () => {
      resolve(Buffer.concat(chunks));
    }),
  );

  let y = 40;
  for (const line of lines) {
    const bold = ['name', 'headline', 'h', 'title'].includes(line.style);
    const size =
      line.style === 'name'
        ? 12
        : line.style === 'headline' || line.style === 'h'
          ? 9
          : line.style === 'bullet' || line.style === 'cont'
            ? 8.4
            : 8.8;
    const x =
      line.style === 'name'
        ? 209
        : line.style === 'headline'
          ? 147
          : line.style === 'contact'
            ? 112
            : line.style === 'bullet'
              ? 51
              : line.style === 'cont'
                ? 56
                : 36;
    // Trechos (texto, negrito?) da linha: rótulo em negrito até o 1º ":" nas linhas "tech" e "skill".
    const colon = line.text.indexOf(':');
    const segments: { text: string; bold: boolean }[] =
      (line.style === 'tech' || line.style === 'skill') && colon > 0
        ? [
            { text: line.text.slice(0, colon + 1), bold: true },
            { text: line.text.slice(colon + 1), bold: false },
          ]
        : [{ text: line.text, bold }];
    let cursor = x;
    for (const segment of segments) {
      doc
        .font(segment.bold ? 'Helvetica-Bold' : 'Helvetica')
        .fontSize(size)
        .text(segment.text, cursor, y, { lineBreak: false });
      cursor += doc.widthOfString(segment.text);
    }
    const offsetOf = (index: number): number => {
      let consumed = 0;
      let offset = x;
      for (const segment of segments) {
        const take = Math.max(0, Math.min(segment.text.length, index - consumed));
        offset += doc
          .font(segment.bold ? 'Helvetica-Bold' : 'Helvetica')
          .fontSize(size)
          .widthOfString(segment.text.slice(0, take));
        consumed += segment.text.length;
      }
      return offset;
    };
    for (const link of line.links ?? []) {
      const from = line.style === 'tech' ? line.text.indexOf('Links:') : 0;
      const index = line.text.indexOf(link.label, from);
      const regular = segments.find((seg) => !seg.bold) ?? segments[0];
      const width = doc
        .font(regular?.bold === false ? 'Helvetica' : 'Helvetica-Bold')
        .fontSize(size)
        .widthOfString(link.label);
      doc.link(offsetOf(index), y - 1, width, size + 2, link.url);
    }
    y += size + 4.5 + (line.style === 'h' ? 3 : 0) + (line.style === 'title' ? 1 : 0);
  }
  doc.end();
  return done;
}
