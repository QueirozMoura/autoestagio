import type { ResolvedEntry, ResolvedResume } from '../../src/cv/index.js';

/**
 * Currículo resolvido FICTÍCIO montado à mão: prova que o renderizador só precisa de um `ResolvedResume`
 * (sem modelo mestre, sem PDF mestre, sem banco). Nenhum dado real.
 */
export interface FictionalResumeOptions {
  /** Bullets extras por entrada (para forçar uma ou duas páginas). */
  extraBullets?: number;
  /** Entradas extras de experiência. */
  extraEntries?: number;
  links?: boolean;
  certifications?: string[];
}

const LOREM =
  'com autenticação, testes automatizados, integração contínua e entrega incremental de funcionalidades para usuários reais';

export function fictionalEntry(id: string, bullets: number, withLinks = true): ResolvedEntry {
  return {
    id,
    title: `Projeto ${id} — Desenvolvedora Full Stack`,
    period: '2025 – 2026',
    bullets: Array.from(
      { length: bullets },
      (_, i) => `Desenvolvi o módulo ${i + 1} do projeto ${id}, ${LOREM} (item ${i + 1}).`,
    ),
    technologies: ['TypeScript', 'React', 'PostgreSQL', 'Docker'],
    links: withLinks
      ? [
          { id: `${id}-demo`, label: 'Demo', url: `https://${id}.example.com/` },
          { id: `${id}-repo`, label: 'GitHub', url: `https://github.example.com/maria/${id}` },
        ]
      : [],
  };
}

export function fictionalResume(options: FictionalResumeOptions = {}): ResolvedResume {
  const extra = options.extraBullets ?? 0;
  const entries = [
    fictionalEntry('oficina', 2 + extra, options.links ?? true),
    fictionalEntry('agenda', 2 + extra, options.links ?? true),
    ...Array.from({ length: options.extraEntries ?? 0 }, (_, i) =>
      fictionalEntry(`extra${i}`, 2 + extra, options.links ?? true),
    ),
  ];
  return {
    language: 'pt-BR',
    area: null,
    header: {
      name: 'Maria Exemplo da Silva',
      headline: 'Estágio em Tecnologia da Informação (TI) — Desenvolvedora Full Stack',
      location: 'São Paulo, SP',
      contacts: [
        { kind: 'telefone', value: '(11) 90000-0000' },
        { kind: 'email', value: 'maria.exemplo@example.com' },
      ],
      links:
        (options.links ?? true)
          ? [
              { id: 'link-github', label: 'GitHub', url: 'https://www.example.com/maria-exemplo' },
              {
                id: 'link-portfolio',
                label: 'Portfólio',
                url: 'https://maria-exemplo.example.com/',
              },
            ]
          : [],
    },
    summary:
      'Desenvolvedora Full Stack com experiência no desenvolvimento de plataformas web e sistemas SaaS, usando React, TypeScript, Node.js e PostgreSQL. Estudante de Análise e Desenvolvimento de Sistemas.',
    experience: { title: 'Experiência em projetos', entries },
    projects: {
      title: 'Outros projetos',
      entries: [fictionalEntry('notas', 2 + extra, options.links ?? true)],
    },
    skills: [
      {
        category: 'Linguagens',
        items: ['JavaScript', 'TypeScript', 'SQL'],
        text: 'Linguagens: JavaScript, TypeScript, SQL',
      },
      { category: 'Testes', items: ['Vitest', 'Playwright'], text: 'Testes: Vitest, Playwright' },
    ],
    education: [
      'Análise e Desenvolvimento de Sistemas — Faculdade Exemplo | Cursando, previsão de conclusão em 2028',
      'Ensino Médio Técnico em Desenvolvimento de Sistemas — Escola Técnica Exemplo | Concluído em 2025',
    ],
    languages: ['Português: Nativo | Inglês: Intermediário (leitura técnica e documentação)'],
    certifications: options.certifications ?? ['Fundamentos de APIs REST — Instituto Exemplo'],
    manifest: {
      schemaVersion: 1,
      modelHash: 'a'.repeat(64),
      approvedAt: '2026-10-22',
      masterSha256: 'b'.repeat(64),
      area: null,
      fidelity: 'fiel',
      variants: [],
      fields: [],
      links: [],
      omitted: {
        linksNotConfirmed: [],
        entriesWithoutApprovedBullets: [],
        certificationsWithoutCuratedText: [],
      },
      contentSha256: 'c'.repeat(64),
    },
  };
}
