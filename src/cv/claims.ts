import { modelTexts } from './fidelity.js';
import { slugify } from './parse.js';
import type { Claim, ClaimKind, CvMaster } from './schema.js';

/**
 * Afirmações do currículo que dependem de fatos fora do PDF (números, uso real, estado atual,
 * comprovantes). A detecção é por padrões de texto: aponta onde olhar, não julga se é verdade.
 * Toda afirmação nasce `pendente`: só você a confirma.
 */

const USERS =
  /(?:usad[oa]s?|utilizad[oa]s?)\s+(?:em\s+média\s+)?por\s+(?:cerca\s+de\s+)?(\d[\d.]*)\s+(?:pessoas|usuários|clientes)/gi;
const TESTS = /(?:mais\s+de\s+)?(\d[\d.]*)\s+testes\s+automatizados(?:\s*\(([^)]*)\))?/gi;
const PRODUCTION =
  /(em\s+produção|vendas\s+(?:reais|recorrentes)|clientes\s+reais|empresa\s+real|estabilidade\s+contínua|gerando\s+vendas)/gi;
const PRESENT = /\b(mantenho|desenvolvo|atualmente|estou)\b/i;

/** Termos técnicos específicos (não genéricos): cada um precisa estar de fato no repositório citado. */
const TECHNICAL = [
  'SELECT FOR UPDATE',
  'bloqueio de linha',
  'chave de idempotência',
  'exclusion constraint',
  'GiST',
  'Argon2id',
  'CSRF',
  'AES-256-GCM',
  'HMAC',
  'CRDTs?',
  'Vector Clocks?',
  'Operation Log',
  'outbox',
  'máquina de estados',
  'OAuth 2\\.0',
  'Rate Limiting',
  'testes de concorrência',
  'isolamento de dados',
  'IA',
  'E2E',
];
const TECHNICAL_RE = new RegExp(`(?:^|[^A-Za-zÀ-ÿ])(${TECHNICAL.join('|')})(?![A-Za-zÀ-ÿ])`, 'g');

const num = (value: string): number => Number(value.replaceAll('.', ''));

export interface ClaimReport {
  claims: Claim[];
  /** Verificações aritméticas (somas, "mais de N") que o texto não fecha. */
  inconsistencies: string[];
}

export function detectClaims(model: CvMaster): ClaimReport {
  const claims: Claim[] = [];
  const inconsistencies: string[] = [];
  const counters = new Map<string, number>();
  const add = (kind: ClaimKind, blockId: string, quote: string, question: string): void => {
    const base = `claim-${kind.replaceAll('_', '-')}-${slugify(blockId, 50)}`;
    const n = (counters.get(base) ?? 0) + 1;
    counters.set(base, n);
    claims.push({
      id: `${base}-${n}`.slice(0, 90),
      blockId,
      kind,
      quote,
      question,
      status: 'pendente',
    });
  };

  const perEntryUsers: { blockId: string; value: number }[] = [];
  let summaryUsers: number | undefined;

  for (const unit of modelTexts(model)) {
    for (const m of unit.text.matchAll(USERS)) {
      const value = num(m[1] ?? '0');
      add(
        'numero_usuarios',
        unit.id,
        m[0],
        `Quantas pessoas usam de fato hoje (${value})? De onde vem o número (contas ativas, analytics, contagem manual) e ele ainda é verdadeiro?`,
      );
      if (unit.section === 'resumo') summaryUsers = value;
      else perEntryUsers.push({ blockId: unit.id, value });
    }
    for (const m of unit.text.matchAll(TESTS)) {
      add(
        'numero_testes',
        unit.id,
        m[0],
        `Qual é a contagem real e atual de testes (${m[1] ?? ''})? Como foi medida e em que repositório/commit?`,
      );
      const parts = [...(m[2] ?? '').matchAll(/(\d[\d.]*)/g)].map((p) => num(p[1] ?? '0'));
      if (parts.length >= 2) {
        const sum = parts.reduce((a, b) => a + b, 0);
        const claimed = num(m[1] ?? '0');
        if (/^mais\s+de/i.test(m[0]) && sum <= claimed) {
          const why = `"${m[0].slice(0, 70)}": as partes somam ${parts.join(' + ')} = ${sum}, o que não é "mais de ${claimed}".`;
          inconsistencies.push(why);
          add(
            'inconsistencia',
            unit.id,
            m[0],
            `${why} O correto é "${claimed}" ou a contagem mudou? Qual texto devo usar?`,
          );
        } else if (!/^mais\s+de/i.test(m[0]) && sum !== claimed) {
          const why = `"${m[0].slice(0, 70)}": as partes somam ${sum}, não ${claimed}.`;
          inconsistencies.push(why);
          add('inconsistencia', unit.id, m[0], `${why} Qual é o número certo?`);
        }
      }
    }
    const production = [...unit.text.matchAll(PRODUCTION)].map((m) => m[0]);
    if (production.length > 0) {
      add(
        'producao_comercial',
        unit.id,
        [...new Set(production)].join(' · '),
        'Isto pode ser comprovado (cliente, receita, relatório)? O cliente/empresa autorizou citar? Continua verdadeiro hoje?',
      );
    }
    const technical = [...new Set([...unit.text.matchAll(TECHNICAL_RE)].map((m) => m[1] ?? ''))];
    if (technical.length > 0 && unit.section !== 'skills') {
      add(
        'tecnica_especifica',
        unit.id,
        technical.join(' · '),
        'Cada técnica citada foi realmente implementada e está no repositório indicado (não só planejada)? Qual arquivo/commit comprova?',
      );
    }
    if (PRESENT.test(unit.text) && unit.section !== 'skills') {
      add(
        'estado_atual',
        unit.id,
        unit.text.slice(0, 120),
        'A frase está no presente. Ainda é verdadeira hoje?',
      );
    }
  }

  // Soma dos usuários dos sistemas × número do resumo.
  if (summaryUsers !== undefined && perEntryUsers.length > 0) {
    const sum = perEntryUsers.reduce((a, b) => a + b.value, 0);
    if (sum !== summaryUsers) {
      const why = `O resumo diz "cerca de ${summaryUsers} pessoas"; os sistemas somam ${perEntryUsers.map((p) => p.value).join(' + ')} = ${sum}.`;
      inconsistencies.push(why);
      add(
        'inconsistencia',
        'resumo',
        `cerca de ${summaryUsers} pessoas`,
        `${why} É um arredondamento aceitável ou prefere citar o valor exato?`,
      );
    }
  }

  for (const cert of model.certifications) {
    add(
      'certificacao',
      cert.id,
      cert.text.slice(0, 140),
      'Há certificado ou comprovante verificável (link/ID)? Título, emissor e ano estão exatos?',
    );
  }
  for (const edu of model.education) {
    if (edu.status === 'cursando') {
      add(
        'periodo_formacao',
        edu.id,
        edu.statusLabel,
        'A previsão de conclusão continua válida? (O perfil aprovado informa junho de 2028; o currículo traz só o ano.)',
      );
    }
  }
  const allLinks = [
    ...model.identity.links,
    ...model.experience.flatMap((e) => e.links),
    ...model.projects.flatMap((e) => e.links),
  ];
  for (const link of allLinks) {
    const hyphen = /-\/?$/.test(new URL(link.url).pathname);
    add(
      'link',
      link.id,
      `${link.label}: ${link.url}`,
      hyphen
        ? 'O endereço termina com hífen: é isso mesmo ou foi truncado? Confira no navegador e confirme (nada foi corrigido).'
        : 'Este endereço é seu, está correto e deve aparecer no currículo?',
    );
  }
  for (const entry of model.experience) {
    if (/\(projeto\s[^)]*\)/i.test(entry.title)) {
      add(
        'estrutura',
        entry.id,
        entry.title.slice(0, 120),
        'A seção "Experiência profissional" lista um projeto. Um ATS pode ler como vínculo de trabalho. Mantém o título da seção ou prefere "Experiência em projetos"?',
      );
    }
  }
  return { claims, inconsistencies };
}
