import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import type { Command } from 'commander';
import { loadConfig, loadProfile } from '../config/index.js';
import {
  buildReport,
  enrichModel,
  extractPdf,
  formatReport,
  loadModel,
  modelHash,
  parseMaster,
  saveModel,
  saveReport,
  verifyLinks,
  type LinkCheck,
} from '../cv/index.js';
import { CV_VARIANTS, inspectVariants } from '../cv/strict-inputs.js';
import { createHttpClient, loadSourcesConfig } from '../sources/index.js';
import { registerCvAttachCommands } from './cv-attach-commands.js';
import { formatGenerate, generateJson, generateResume } from './cv-generate.js';
import { formatVariants, variantsJson } from './cv-variants.js';
import type { StrictInputsOptions } from '../cv/strict-inputs.js';

/** Caminho do PDF mestre: --pdf, ou o currículo registrado na aprovação do perfil. */
function masterPdfPath(option: string | undefined): string {
  if (option !== undefined) return option;
  const profile = loadProfile(loadConfig().profilePath);
  const fromProfile = profile?.approval?.cvFile;
  if (fromProfile === undefined)
    throw new Error('Informe o PDF com --pdf (o perfil não tem um currículo aprovado registrado).');
  return fromProfile;
}

function poppler(pdf: string): { extractor: string; text: string } | undefined {
  const run = spawnSync('pdftotext', ['-enc', 'UTF-8', pdf, '-'], { encoding: 'utf8' });
  return run.status === 0 ? { extractor: 'poppler (pdftotext)', text: run.stdout } : undefined;
}

/** Opções do carregador estrito a partir da configuração real; a âncora vem sempre do operador. */
function strictInputsOptions(anchorSha256: string | undefined): StrictInputsOptions {
  const config = loadConfig();
  const approval = loadProfile(config.profilePath)?.approval;
  return {
    modelPath: config.cvModelPath,
    masterPdf:
      approval === undefined ? undefined : { path: approval.cvFile, sha256: approval.cvSha256 },
    anchorSha256,
  };
}

export function registerCvCommands(program: Command): void {
  const cv = program
    .command('cv')
    .description(
      'Modelo mestre do currículo: extração, fidelidade e conferência (nada é aprovado automaticamente)',
    );

  cv.command('extract')
    .description(
      'Extrai o PDF mestre (somente leitura) para o modelo local config/cv-master.json (fora do Git)',
    )
    .option('--pdf <caminho>', 'PDF mestre (padrão: o currículo registrado na aprovação do perfil)')
    .option('--force', 'regera o modelo existente (mantém o anterior como .bak)')
    .action(async (options: { pdf?: string; force?: boolean }) => {
      const config = loadConfig();
      const pdf = masterPdfPath(options.pdf);
      const extraction = await extractPdf(pdf);
      const profile = loadProfile(config.profilePath);
      if (profile?.approval !== undefined && profile.approval.cvSha256 !== extraction.sha256) {
        console.warn('Aviso: o SHA-256 deste PDF difere do currículo aprovado no perfil.');
      }
      const { model, notes } = parseMaster(extraction);
      const enriched = enrichModel(model);
      saveModel(config.cvModelPath, enriched, { overwrite: options.force === true });
      console.log(`Modelo gravado em ${config.cvModelPath} (permissão 0600, fora do Git).`);
      console.log(
        `PDF mestre: ${extraction.label} | SHA-256 ${extraction.sha256.slice(0, 12)}… | ${extraction.pages} página(s) | extrator ${extraction.extractor.name} ${extraction.extractor.version}`,
      );
      console.log(
        `Estrutura: ${enriched.experience.length} experiências, ${enriched.projects.length} projetos, ${enriched.skills.length} categorias de skills, ${enriched.education.length} formações, ${enriched.languages.length} idioma(s), ${enriched.certifications.length} certificação(ões), ${enriched.identity.links.length + enriched.experience.reduce((n, e) => n + e.links.length, 0) + enriched.projects.reduce((n, e) => n + e.links.length, 0)} links.`,
      );
      console.log(
        `Afirmações a confirmar: ${enriched.claims.length} | propostas (não aprovadas): ${enriched.proposals.items.length}`,
      );
      for (const note of notes) console.log(`  ⚠ ${note}`);
      console.log(
        'Nada foi aprovado: todos os blocos estão em "rascunho" e nenhum link foi confirmado. Rode "cv report" para revisar.',
      );
    });

  cv.command('report')
    .description('Relatório de fidelidade, afirmações a confirmar, links e propostas')
    .option('--pdf <caminho>', 'PDF mestre (padrão: o currículo registrado na aprovação do perfil)')
    .option(
      '--links',
      'confere os links na internet (poucas requisições, ritmo limitado, só leitura)',
    )
    .option('--json', 'saída em JSON')
    .option('--no-save', 'não grava o relatório em data/cv-reports')
    .action(async (options: { pdf?: string; links?: boolean; json?: boolean; save: boolean }) => {
      const config = loadConfig();
      const model = loadModel(config.cvModelPath);
      if (model === undefined) throw new Error('Não há modelo. Rode "cv extract" primeiro.');
      const pdf = masterPdfPath(options.pdf);
      const extraction = await extractPdf(pdf);
      let links: LinkCheck[] | undefined;
      if (options.links === true) {
        links = await verifyLinks(model, {
          http: createHttpClient(loadSourcesConfig()),
          claims: buildReport({ model, extraction }).claims,
        });
      }
      const cross = poppler(pdf);
      const report = buildReport({
        model,
        extraction,
        ...(cross === undefined ? {} : { crossCheck: cross }),
        ...(links === undefined ? {} : { links }),
      });
      console.log(
        options.json === true ? JSON.stringify(report, null, 2) : formatReport(report, model),
      );
      if (options.save) {
        const file = saveReport(join(dirname(config.databasePath), 'cv-reports'), report);
        console.log(`\nRelatório gravado em ${file} (0600, fora do Git).`);
      }
    });

  cv.command('status')
    .description('Estado do modelo mestre (aprovações pendentes)')
    .action(() => {
      const config = loadConfig();
      const model = loadModel(config.cvModelPath);
      if (model === undefined) {
        console.log('Sem modelo. Rode "cv extract".');
        return;
      }
      const variants = [
        model.identity.headline,
        model.summary,
        ...model.experience.flatMap((e) => e.bullets),
        ...model.projects.flatMap((e) => e.bullets),
      ].flatMap((b) => b.variants);
      const links = [
        ...model.identity.links,
        ...model.experience.flatMap((e) => e.links),
        ...model.projects.flatMap((e) => e.links),
      ];
      console.log(
        [
          `Modelo: ${config.cvModelPath}`,
          `PDF mestre: ${model.master.label} | SHA-256 ${model.master.sha256.slice(0, 12)}…`,
          `Hash do conteúdo: ${modelHash(model).slice(0, 12)}…`,
          `Modelo aprovado: ${model.approval === undefined ? 'NÃO' : `sim (${model.approval.approvedAt})`}`,
          `Blocos aprovados: ${variants.filter((v) => v.status === 'aprovado').length}/${variants.length}`,
          `Links confirmados: ${links.filter((l) => l.confirmedByUser).length}/${links.length}`,
          `Afirmações pendentes: ${model.claims.filter((c) => c.status === 'pendente').length}/${model.claims.length} (confirmadas: ${model.claims.filter((c) => c.status === 'confirmada').length}, rejeitadas: ${model.claims.filter((c) => c.status === 'rejeitada').length})`,
          `Propostas (não aprovadas): ${model.proposals.items.length}`,
        ].join('\n'),
      );
    });

  cv.command('variants')
    .description(
      'Lista as variantes do currículo: estado editorial, elegibilidade e pré-condições locais (não valida nem gera PDF)',
    )
    .option(
      '--ancora-sha256 <hash>',
      'SHA-256 do arquivo de âncora de confiança (referência explícita; sem ela as pré-condições ficam indisponíveis)',
    )
    .option('--json', 'saída em JSON')
    .action((options: { ancoraSha256?: string; json?: boolean }) => {
      const variants = inspectVariants(strictInputsOptions(options.ancoraSha256));
      console.log(
        options.json === true
          ? JSON.stringify(variantsJson(variants), null, 2)
          : formatVariants(variants),
      );
    });

  cv.command('generate')
    .description(
      'Gera o PDF de uma variante pelo fluxo estrito (nunca sobrescreve; só publica se a validação estiver completa)',
    )
    .option('--variant <id>', `variante (${CV_VARIANTS.map((v) => v.id).join(', ')})`)
    .option('--ancora-sha256 <hash>', 'SHA-256 do arquivo de âncora de confiança (obrigatório)')
    .option(
      '--output <diretorio>',
      'diretório de saída (padrão: data/cv-output/, criado com 0700); o nome do arquivo é definido pelo programa',
    )
    .option('--json', 'saída em JSON')
    .action(
      async (options: {
        variant?: string;
        ancoraSha256?: string;
        output?: string;
        json?: boolean;
      }) => {
        const outcome = await generateResume({
          variant: options.variant,
          inputs: strictInputsOptions(options.ancoraSha256),
          ...(options.output === undefined ? {} : { output: options.output }),
        });
        console.log(
          options.json === true
            ? JSON.stringify(generateJson(outcome), null, 2)
            : formatGenerate(outcome),
        );
        if (!outcome.ok) process.exitCode = 1;
      },
    );

  registerCvAttachCommands(cv, strictInputsOptions);
}
