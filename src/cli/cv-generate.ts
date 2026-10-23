import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import {
  CV_VARIANTS,
  StrictInputsError,
  loadStrictInputs,
  type StrictInputsOptions,
} from '../cv/strict-inputs.js';
import { renderAndValidateResume, type StrictResumeResult } from '../cv/strict.js';
import { resolveFromRoot } from '../utils/paths.js';
import {
  SafeWriteError,
  writePrivateExclusive,
  type SafeWriteFs,
  type SafeWriteOptions,
  type SafeWriteResult,
} from '../utils/safe-write.js';

/** Diretório padrão (dentro do projeto, ignorado pelo Git, criado com 0700 pelo safe-write). */
export const DEFAULT_OUTPUT_DIR = 'data/cv-output';

export interface GenerateDeps {
  /** Única porta de geração estrita; substituível apenas nos testes. */
  render?: (input: Parameters<typeof renderAndValidateResume>[0]) => Promise<StrictResumeResult>;
  write?: (options: SafeWriteOptions) => SafeWriteResult;
  writeFs?: Partial<SafeWriteFs>;
  now?: () => Date;
}
export interface GenerateRequest {
  variant: string | undefined;
  /** Opções do carregador das entradas estritas (modelo, PDF mestre, referência da âncora...). */
  inputs: StrictInputsOptions;
  /** Diretório escolhido pelo usuário; o NOME do arquivo é sempre construído aqui. */
  output?: string;
  /** Raiz usada para resolver o diretório padrão. */
  root?: string;
}

export type GenerateStage = 'entrada' | 'carregamento' | 'validacao' | 'gravacao';
export type GenerateOutcome =
  | {
      ok: true;
      variant: string;
      path: string;
      pages: number;
      validation: 'estrita-completa';
      durable: boolean;
      tempCleanup: 'removed' | 'left-behind';
      leftoverTemp?: string;
    }
  | {
      ok: false;
      stage: GenerateStage;
      code: string;
      message: string;
      /** Códigos de problemas da validação estrita (enumeração fixa, sem conteúdo). */
      issues?: string[];
    };

const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
const pad = (n: number): string => String(n).padStart(2, '0');
const stamp = (d: Date): string => `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
const fail = (
  stage: GenerateStage,
  code: string,
  message: string,
  issues?: string[],
): GenerateOutcome => ({
  ok: false,
  stage,
  code,
  message,
  ...(issues === undefined ? {} : { issues }),
});

const CHECKS = ['H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'H7', 'H8', 'H9', 'H10'];

/** Autorização de publicação: somente o relatório ESTRITO e o artefato selado; nunca o diagnóstico sozinho. */
function publishable(result: StrictResumeResult): boolean {
  const { report, artifact } = result;
  const d = report.diagnostic;
  return (
    report.ok &&
    report.complete &&
    report.fontIdentity.status === 'verified' &&
    report.referenceIntegrity === 'verified' &&
    report.issues.length === 0 &&
    report.bindings !== null &&
    d !== null &&
    artifact !== undefined &&
    typeof artifact.readBytes === 'function' &&
    Number.isInteger(artifact.pages) &&
    artifact.pages >= 1 &&
    report.bindings.pdfSha256 === artifact.pdfSha256 &&
    d.pdfSha256 === artifact.pdfSha256 &&
    d.pages === artifact.pages &&
    CHECKS.every((id) => d.checks.filter((c) => c.id === id && c.status === 'pass').length === 1) &&
    d.extractors.some((e) => e.name === 'poppler (pdftotext)' && e.status === 'used')
  );
}

/** Fluxo único: carregar (4.4a) -> renderAndValidateResume (4.3) -> writePrivateExclusive (4.4b). */
export async function generateResume(
  request: GenerateRequest,
  deps: GenerateDeps = {},
): Promise<GenerateOutcome> {
  const variant = CV_VARIANTS.find((v) => v.id === request.variant);
  if (variant === undefined)
    return fail(
      'entrada',
      'VARIANT_UNKNOWN',
      `Variante inexistente. Use: ${CV_VARIANTS.map((v) => v.id).join(', ')}.`,
    );
  const render = deps.render ?? renderAndValidateResume;
  const write = deps.write ?? writePrivateExclusive;

  let result: StrictResumeResult;
  try {
    result = await render(loadStrictInputs(request.inputs).inputFor(variant.id));
  } catch (error) {
    if (error instanceof StrictInputsError)
      return fail('carregamento', error.code, `${error.message} Nenhum PDF foi gerado.`);
    return fail(
      'validacao',
      'UNEXPECTED',
      'Falha inesperada na geração estrita. Nenhum PDF foi publicado.',
    );
  }
  if (!publishable(result))
    return fail(
      'validacao',
      'VALIDATION_FAILED',
      'A validação estrita não foi concluída; nenhum PDF foi publicado.',
      [...result.report.issues],
    );

  // `publishable` garante o artefato; os bytes só saem pelo método autorizado e são conferidos.
  const artifact = result.artifact;
  if (artifact === undefined) return fail('validacao', 'ARTIFACT_MISSING', 'Artefato ausente.');
  const bytes = artifact.readBytes();
  const digest = sha256(bytes);
  if (digest !== artifact.pdfSha256)
    return fail(
      'validacao',
      'ARTIFACT_HASH_MISMATCH',
      'Os bytes do PDF não correspondem ao hash atestado; nenhum PDF foi publicado.',
    );

  const dir =
    request.output === undefined
      ? resolveFromRoot(DEFAULT_OUTPUT_DIR, request.root)
      : resolve(request.output);
  const name = `curriculo-${variant.id}-${stamp((deps.now ?? (() => new Date()))())}-${digest.slice(0, 8)}.pdf`;
  try {
    const written = write({
      dir,
      name,
      bytes,
      sha256: digest,
      ...(deps.writeFs === undefined ? {} : { fs: deps.writeFs }),
    });
    return {
      ok: true,
      variant: variant.id,
      path: written.path,
      pages: artifact.pages,
      validation: 'estrita-completa',
      durable: written.durable,
      tempCleanup: written.tempCleanup,
      ...(written.leftoverTemp === undefined ? {} : { leftoverTemp: written.leftoverTemp }),
    };
  } catch (error) {
    if (error instanceof SafeWriteError)
      return fail(
        'gravacao',
        error.code,
        error.code === 'ALREADY_EXISTS'
          ? error.message
          : `${error.message} Nenhum arquivo final foi criado.`,
      );
    return fail(
      'gravacao',
      'UNEXPECTED',
      'Falha inesperada na gravação. Confira o diretório de saída: o estado do arquivo final é desconhecido.',
    );
  }
}

export function formatGenerate(outcome: GenerateOutcome): string {
  if (!outcome.ok) {
    const extra = outcome.issues === undefined ? '' : `\nProblemas: ${outcome.issues.join(', ')}`;
    return `Falha na geração (${outcome.stage}, código ${outcome.code}): ${outcome.message}${extra}`;
  }
  const lines = [
    `Currículo gerado: ${outcome.variant}`,
    `Arquivo: ${outcome.path}`,
    `Páginas: ${outcome.pages}`,
    'Validação estrita: completa (H1–H10, Poppler e identidade das fontes verificados)',
    outcome.durable
      ? 'Durabilidade: confirmada'
      : 'Durabilidade: NÃO confirmada (o arquivo foi publicado, mas o fsync do diretório falhou)',
  ];
  if (outcome.tempCleanup === 'left-behind')
    lines.push(
      `Aviso: o PDF foi publicado e está íntegro, mas sobrou um arquivo temporário no diretório de saída (${outcome.leftoverTemp ?? 'nome desconhecido'}); remova-o manualmente.`,
    );
  return lines.join('\n');
}

/** Metadados seguros: nunca inclui conteúdo, hashes ou registros de aprovação. */
export function generateJson(outcome: GenerateOutcome): unknown {
  return outcome;
}
