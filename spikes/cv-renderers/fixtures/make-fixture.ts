/**
 * Gera o fixture FICTÍCIO (Maria Exemplo) validado pelo esquema proposto. Nenhum dado real:
 * nomes, empresas, projetos e links são inventados (domínio example.com).
 */
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { cvModelSchema } from '../model.schema.ts';

const sha = (text: string): string => createHash('sha256').update(text).digest('hex');
const ref = (section: string, text: string) => ({ section, excerptSha256: sha(text) });
const t = (ptBR: string) => ({ 'pt-BR': ptBR });
const variant = (id: string, text: string, section: string, extra: Record<string, unknown> = {}) => ({
  id,
  text: t(text),
  areas: [],
  technologies: [],
  sourceRef: ref(section, text),
  approvedAt: '2026-10-22',
  ...extra,
});
const block = (id: string, variants: ReturnType<typeof variant>[], extra: Record<string, unknown> = {}) => ({
  id,
  required: false,
  priority: 50,
  variants,
  ...extra,
});
const period = (start: string, end?: string) => ({ start, ...(end ? { end } : {}) });

const model = {
  schemaVersion: 1,
  language: 'pt-BR',
  master: { sha256: 'f'.repeat(64), label: 'curriculo-ficticio-mestre.pdf', extractedAt: '2026-10-22' },
  identity: {
    name: 'Maria Exemplo da Silva',
    headline: block(
      'headline',
      [
        variant('headline-dev', 'Estágio em Tecnologia da Informação (TI) — Desenvolvedora Full Stack', 'cabecalho', { areas: ['desenvolvimento'] }),
        variant('headline-qa', 'Estágio em TI — Qualidade de Software (QA) e Testes Automatizados', 'cabecalho', { areas: ['qa'] }),
      ],
      { required: true },
    ),
    location: 'São Paulo, SP',
    contacts: [
      { id: 'email', kind: 'email', value: 'maria.exemplo@example.com' },
      { id: 'telefone', kind: 'telefone', value: '(11) 90000-0000' },
    ],
    links: [
      { id: 'link-linkedin', label: 'LinkedIn', url: 'https://www.example.com/maria-exemplo/linkedin', confirmedByUser: false },
      { id: 'link-github', label: 'GitHub', url: 'https://www.example.com/maria-exemplo/github', confirmedByUser: false },
      { id: 'link-portfolio', label: 'Portfólio', url: 'https://maria-exemplo.example.com/', confirmedByUser: false },
    ],
  },
  summary: block(
    'resumo',
    [
      variant(
        'resumo-dev',
        'Desenvolvedora Full Stack com três sistemas fictícios em produção usados por cerca de 100 pessoas, incluindo uma plataforma comercial que gera vendas reais para uma oficina. Experiência com SaaS multiempresa, integridade de dados em transações concorrentes, testes automatizados e segurança, usando React, TypeScript, Node.js e PostgreSQL. Estudante de Análise e Desenvolvimento de Sistemas e Técnica em Desenvolvimento de Sistemas.',
        'resumo',
        { areas: ['desenvolvimento'], technologies: ['React', 'TypeScript', 'Node.js', 'PostgreSQL'] },
      ),
      variant(
        'resumo-qa',
        'Estudante de Análise e Desenvolvimento de Sistemas com foco em qualidade: mais de 500 testes automatizados (unitários, de integração e E2E) em projetos fictícios, com CI/CD no GitHub Actions. Experiência em React, TypeScript, Node.js e PostgreSQL.',
        'resumo',
        { areas: ['qa'], technologies: ['React', 'TypeScript', 'Node.js', 'PostgreSQL'] },
      ),
    ],
    { required: true },
  ),
  experience: [
    {
      id: 'exp-oficina',
      kind: 'experiencia',
      title: t('Oficina Exemplo Ltda. — Desenvolvedora Full Stack (projeto para empresa real)'),
      period: period('2026'),
      technologies: ['React', 'Node.js', 'Express', 'PostgreSQL', 'Prisma ORM', 'Tailwind CSS'],
      links: [{ id: 'exp-oficina-demo', label: 'Demo', url: 'https://oficina-exemplo.example.com/demo', confirmedByUser: false }],
      priority: 90,
      sourceRef: ref('experiencia', 'oficina'),
      bullets: [
        block('exp-oficina-b1', [
          variant('exp-oficina-b1-a', 'Desenvolvi e mantenho em produção uma plataforma comercial com painel administrativo, gestão de ordens de serviço e e-commerce, usada em média por 40 pessoas e gerando vendas recorrentes todos os meses via API de pagamentos.', 'experiencia'),
          variant('exp-oficina-b1-b', 'Plataforma comercial em produção (painel administrativo, ordens de serviço e e-commerce), com vendas recorrentes todos os meses.', 'experiencia'),
        ]),
        block('exp-oficina-b2', [
          variant('exp-oficina-b2-a', 'Implementei autenticação JWT, webhooks, validação HMAC e camadas de segurança (Helmet, CSP, Rate Limiting); deploy em produção com estabilidade contínua para clientes reais.', 'experiencia'),
        ]),
      ],
    },
    {
      id: 'exp-ordemfacil',
      kind: 'experiencia',
      title: t('OrdemFácil — SaaS para Oficinas (projeto autoral)'),
      period: period('2026'),
      technologies: ['TypeScript', 'Fastify', 'React', 'Vite', 'PostgreSQL', 'Prisma ORM', 'Zod', 'Vitest', 'Playwright'],
      links: [{ id: 'exp-ordemfacil-demo', label: 'Demo', url: 'https://ordemfacil.example.com/', confirmedByUser: false }],
      priority: 80,
      sourceRef: ref('experiencia', 'ordemfacil'),
      bullets: [
        block('exp-ordemfacil-b1', [
          variant('exp-ordemfacil-b1-a', 'Desenvolvi um SaaS multiempresa, usado em média por 20 pessoas, para gestão de ordens de serviço, orçamentos, pagamentos e garantias, com isolamento de dados por empresa e controle de acesso por papel.', 'experiencia'),
        ]),
        block('exp-ordemfacil-b2', [
          variant('exp-ordemfacil-b2-a', 'Garanti a integridade financeira com valores em Decimal, transações com bloqueio de linha (SELECT FOR UPDATE) contra condições de corrida e chave de idempotência nos pagamentos.', 'experiencia', { areas: ['desenvolvimento', 'banco-de-dados'] }),
          variant('exp-ordemfacil-b2-qa', 'Testes unitários, de integração com PostgreSQL real e E2E com Playwright, com CI no GitHub Actions.', 'experiencia', { areas: ['qa'] }),
        ]),
      ],
    },
    {
      id: 'exp-agendamais',
      kind: 'experiencia',
      title: t('AgendaMais — SaaS de Agendamento e Atendimento (projeto autoral)'),
      period: period('2026'),
      technologies: ['TypeScript', 'React', 'Fastify', 'PostgreSQL', 'Docker'],
      links: [],
      priority: 70,
      sourceRef: ref('experiencia', 'agendamais'),
      bullets: [
        block('exp-agendamais-b1', [
          variant('exp-agendamais-b1-a', 'Desenvolvi uma plataforma multiempresa, usada em média por 35 pessoas, para gestão de agenda, serviços e profissionais, com cálculo de horários livres por fuso horário e confirmação pelo WhatsApp.', 'experiencia'),
        ]),
        block('exp-agendamais-b2', [
          variant('exp-agendamais-b2-a', 'Impedi agendamentos sobrepostos mesmo sob concorrência com exclusion constraint GiST no PostgreSQL, chave de idempotência na criação e controle de versão contra edições simultâneas.', 'experiencia'),
        ]),
      ],
    },
  ],
  projects: [
    {
      id: 'proj-notasfacil',
      kind: 'projeto',
      title: t('NotasFácil — Plataforma de Gestão de Compras, Documentos e Garantias'),
      period: period('2026'),
      technologies: ['TypeScript', 'React', 'Node.js', 'Express', 'PostgreSQL'],
      links: [{ id: 'proj-notasfacil-gh', label: 'GitHub', url: 'https://www.example.com/maria-exemplo/notasfacil', confirmedByUser: false }],
      priority: 60,
      sourceRef: ref('projetos', 'notasfacil'),
      bullets: [
        block('proj-notasfacil-b1', [
          variant('proj-notasfacil-b1-a', 'Aplicação Full Stack para centralizar compras, notas fiscais e garantias, com dashboard de vencimentos, autenticação JWT e Google OAuth 2.0 e upload seguro de arquivos.', 'projetos'),
        ]),
        block('proj-notasfacil-b2', [
          variant('proj-notasfacil-b2-a', 'Mais de 500 testes automatizados (250 no frontend e 250 no backend), cobrindo componentes de interface e rotas de API.', 'projetos', { areas: ['qa'] }),
        ]),
      ],
    },
    {
      id: 'proj-synclab',
      kind: 'projeto',
      title: t('SyncLab Exemplo — Plataforma Web Offline-First com Sincronização de Dados'),
      period: period('2025'),
      technologies: ['TypeScript', 'Vite', 'SQLite/WASM', 'PostgreSQL'],
      links: [],
      priority: 40,
      sourceRef: ref('projetos', 'synclab'),
      bullets: [
        block('proj-synclab-b1', [
          variant('proj-synclab-b1-a', 'Apliquei SQLite/WASM para funcionamento offline, com sincronização via CRDTs e Vector Clocks e Operation Log append-only.', 'projetos'),
        ]),
      ],
    },
  ],
  education: [
    {
      id: 'edu-ads',
      course: t('Análise e Desenvolvimento de Sistemas'),
      institution: 'Faculdade Exemplo',
      degreeType: 'tecnologo',
      status: 'cursando',
      statusLabel: t('Cursando, previsão de conclusão em 2028'),
      sourceRef: ref('educacao', 'ads'),
    },
    {
      id: 'edu-tec',
      course: t('Ensino Médio Técnico em Desenvolvimento de Sistemas'),
      institution: 'Escola Técnica Exemplo',
      degreeType: 'tecnico',
      status: 'concluido',
      statusLabel: t('Concluído em 2025'),
      sourceRef: ref('educacao', 'tec'),
    },
  ],
  skills: [
    { id: 'sk-linguagens', category: t('Linguagens'), items: ['JavaScript (ES6+)', 'TypeScript', 'SQL'], priority: 90, areas: [], sourceRef: ref('skills', 'l') },
    { id: 'sk-front', category: t('Front-end'), items: ['React', 'Vite', 'Tailwind CSS', 'HTML5', 'CSS3', 'Design Responsivo'], priority: 80, areas: ['desenvolvimento'], sourceRef: ref('skills', 'f') },
    { id: 'sk-back', category: t('Back-end'), items: ['Node.js', 'Express', 'Fastify', 'API REST', 'JWT', 'OAuth 2.0', 'Webhooks', 'Zod'], priority: 80, areas: ['desenvolvimento'], sourceRef: ref('skills', 'b') },
    { id: 'sk-bd', category: t('Banco de Dados'), items: ['PostgreSQL', 'MySQL', 'SQLite/WASM', 'Prisma ORM'], priority: 70, areas: ['banco-de-dados'], sourceRef: ref('skills', 'd') },
    { id: 'sk-testes', category: t('Testes'), items: ['Vitest', 'Testing Library', 'Playwright (E2E)', 'testes de integração'], priority: 70, areas: ['qa'], sourceRef: ref('skills', 't') },
    { id: 'sk-ferr', category: t('Ferramentas'), items: ['Git', 'GitHub', 'GitHub Actions', 'Docker', 'CI/CD', 'Metodologias Ágeis'], priority: 60, areas: [], sourceRef: ref('skills', 'x') },
  ],
  languages: [{ id: 'lang', label: t('Português: Nativo | Inglês: Intermediário (leitura técnica e documentação)'), sourceRef: ref('idiomas', 'i') }],
  certifications: [
    { id: 'cert-api', title: t('Fundamentos de APIs REST — aplicações e boas práticas de integração'), issuer: 'Instituto Exemplo', year: 2026, sourceRef: ref('certificacoes', 'c') },
  ],
};

const parsed = cvModelSchema.parse(model);
writeFileSync(new URL('./cv-fixture.json', import.meta.url), `${JSON.stringify(parsed, null, 2)}\n`);
console.log('fixture válido pelo esquema proposto:', parsed.experience.length, 'experiências,', parsed.projects.length, 'projetos');
