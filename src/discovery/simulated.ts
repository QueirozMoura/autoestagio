import type { JobSource, RawJob } from '../sources/index.js';

/**
 * Fontes fictícias para exercitar normalização, deduplicação e persistência sem rede.
 * Empresas, vagas e domínios (.test, reservado pela RFC 2606) são inventados.
 */

const PLATAFORMA_HTML = `<p>Estamos buscando uma pessoa estagiária para atuar na equipe de plataforma,
desenvolvendo APIs em Node.js e TypeScript, escrevendo testes automatizados e participando de
revisões de código com a equipe.</p>
<ul><li>Cursando Análise e Desenvolvimento de Sistemas ou áreas relacionadas</li>
<li>Conhecimento de JavaScript, SQL e Git</li>
<li>Vontade de aprender boas práticas de arquitetura e entrega contínua</li></ul>
<p>Oferecemos mentoria semanal, vale-refeição e horário flexível.</p>`;

/** Mesmo texto de PLATAFORMA_HTML, como um agregador o republicaria (sem HTML). */
const PLATAFORMA_TEXTO = `Estamos buscando uma pessoa estagiária para atuar na equipe de plataforma,
desenvolvendo APIs em Node.js e TypeScript, escrevendo testes automatizados e participando de
revisões de código com a equipe.
- Cursando Análise e Desenvolvimento de Sistemas ou áreas relacionadas
- Conhecimento de JavaScript, SQL e Git
- Vontade de aprender boas práticas de arquitetura e entrega contínua
Oferecemos mentoria semanal, vale-refeição e horário flexível.`;

const DADOS_HTML = `<p>A área de dados procura estagiário para construir pipelines de ingestão em Python,
orquestrados com Airflow, e apoiar a modelagem dimensional do nosso data warehouse.</p>
<p>Você vai trabalhar com consultas analíticas, qualidade de dados e documentação de tabelas,
acompanhando cientistas e analistas em projetos de relatórios para diretoria.</p>
<ul><li>Noções de estatística e bancos relacionais</li><li>Interesse por engenharia de dados</li></ul>`;

const PAGAMENTOS_HTML = `<p>Time de pagamentos recebe estagiário para evoluir microsserviços em Java e Kafka,
cuidando de conciliação financeira, antifraude e conformidade com padrões de segurança do setor
de cartões.</p><p>Rotina com plantões educativos, análise de incidentes e melhoria de observabilidade
usando Grafana e Prometheus, sempre acompanhado por pessoas seniores da equipe.</p>`;

const SUPORTE_HTML = `<p>Atendimento de chamados de primeiro nível, configuração de estações de trabalho e
acompanhamento de incidentes junto à infraestrutura. Modalidade: Remoto.</p>`;

function source(kind: string, slug: string, name: string, jobs: readonly unknown[]): JobSource {
  return {
    kind,
    slug,
    name,
    // eslint-disable-next-line @typescript-eslint/require-await
    async *fetchJobs() {
      // As vagas inválidas de propósito passam pelo mesmo caminho que as válidas.
      yield* jobs as RawJob[];
    },
  };
}

export function createSimulatedSources(): JobSource[] {
  return [
    source('simulado', 'alfa-tecnologia', 'Empresa Alfa Tecnologia (fictícia)', [
      {
        externalId: 'A-101',
        url: 'https://vagas.alfa.test/jobs/101?utm_source=newsletter&utm_medium=email',
        title: 'Estagiário(a) de Desenvolvimento Backend',
        company: 'Empresa Alfa Tecnologia Ltda.',
        location: 'São Paulo, SP - Híbrido',
        description: PLATAFORMA_HTML,
        compensationText: 'Bolsa de R$ 1.800,00 + VR',
        postedAt: '2026-10-15T10:00:00-03:00',
      },
      {
        // Mesma empresa, título e local de A-101, mas outra vaga (equipe de dados).
        externalId: 'A-102',
        url: 'https://vagas.alfa.test/jobs/102',
        title: 'Estagiário(a) de Desenvolvimento Backend',
        company: 'Empresa Alfa Tecnologia Ltda.',
        location: 'São Paulo, SP - Híbrido',
        description: DADOS_HTML,
        compensationText: 'R$ 1.800',
        postedAt: '2026-10-16T09:30:00-03:00',
      },
      {
        externalId: 'A-103',
        url: 'https://vagas.alfa.test/jobs/103/',
        title: 'Estágio em QA',
        company: 'Empresa Alfa Tecnologia Ltda.',
        location: 'Remoto',
        description: '<p>Escrita de testes automatizados com Playwright e Vitest.</p>',
      },
      // Inválidas de propósito: sem URL, e com URL que não é HTTP(S).
      { externalId: 'A-104', title: 'Vaga sem URL', company: 'Empresa Alfa Tecnologia Ltda.' },
      {
        externalId: 'A-105',
        url: 'ftp://arquivos.alfa.test/vaga.txt',
        title: 'Vaga com URL não HTTP',
      },
    ]),

    source('simulado', 'beta-sistemas', 'Beta Sistemas (fictícia)', [
      {
        externalId: 'B-1',
        url: 'https://carreiras.beta.test/vaga/55?gh_src=abc&ref=linkedin#apply',
        title: 'Estagiário em Infraestrutura',
        company: 'Beta Sistemas S.A.',
        location: 'Osasco, SP - Presencial',
        compensationText: 'R$ 1.100 a R$ 1.400',
      },
      {
        externalId: 'B-2',
        url: 'https://carreiras.beta.test/vaga/56',
        title: 'Estágio Suporte Técnico',
        company: 'Beta Sistemas S.A.',
        location: 'São Paulo, SP',
        description: SUPORTE_HTML,
        compensationText: 'A combinar',
      },
    ]),

    // Cada fonte abaixo republica vaga(s) de outras fontes e exercita um cenário diferente.
    // (Dentro de uma mesma fonte, identificadores externos diferentes são sempre vagas diferentes.)
    source('simulado', 'agregador-a', 'Agregador A (fictício)', [
      {
        // Mesma vaga A-101: a URL só difere nos parâmetros de rastreamento. → unificada por URL.
        externalId: 'G-9001',
        url: 'https://www.vagas.alfa.test/jobs/101/?utm_campaign=outubro',
        title: 'Estagiário de Desenvolvimento Backend',
        company: 'Empresa Alfa Tecnologia',
        location: 'São Paulo, SP',
      },
    ]),

    source('simulado', 'portal-b', 'Portal B (fictício)', [
      {
        // Mesma vaga A-101 em outra URL: identidade igual + descrição praticamente igual.
        externalId: 'P-77',
        url: 'https://portal-b.test/p/881',
        title: 'Estagiário(a) de Desenvolvimento Backend',
        company: 'Empresa Alfa Tecnologia',
        location: 'São Paulo, SP',
        description: PLATAFORMA_TEXTO,
      },
    ]),

    source('simulado', 'quadro-c', 'Quadro C (fictício)', [
      {
        // Mesma empresa, título e local, mas descrição totalmente diferente: vaga nova, apenas
        // sinalizada como possível duplicata (nunca unificada).
        externalId: 'Q-5',
        url: 'https://quadro-c.test/p/882',
        title: 'Estagiário(a) de Desenvolvimento Backend',
        company: 'Empresa Alfa Tecnologia',
        location: 'São Paulo, SP',
        description: PAGAMENTOS_HTML,
      },
    ]),
  ];
}
