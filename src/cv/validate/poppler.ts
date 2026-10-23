import { spawnSync } from 'node:child_process';

/**
 * Poppler (pdftotext) como segundo extrator, OPCIONAL. O PDF vai pela entrada padrão (nenhum arquivo
 * temporário) e só os executáveis conhecidos são chamados.
 *
 *  - `auto` (padrão): usa se estiver instalado; se não, a verificação fica `skipped`;
 *  - `require`: a ausência do Poppler é falha;
 *  - `off`: não usa.
 */
export type PopplerMode = 'auto' | 'require' | 'off';

export interface RunResult {
  /** Código de saída; `null` quando o processo não pôde rodar (ex.: executável ausente). */
  status: number | null;
  stdout: string;
  stderr: string;
}

/** Executa um programa do Poppler com o PDF na entrada padrão. Injetável nos testes. */
export type PopplerRunner = (
  command: 'pdftotext' | 'pdffonts',
  args: string[],
  input: Buffer,
) => RunResult;

export const defaultRunner: PopplerRunner = (command, args, input) => {
  const run = spawnSync(command, args, {
    input,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    timeout: 30_000,
  });
  return {
    status: run.error === undefined ? run.status : null,
    stdout: run.stdout,
    stderr: run.stderr,
  };
};

export interface PopplerText {
  available: boolean;
  version?: string;
  /** Texto na ordem do fluxo de conteúdo (`pdftotext -raw`). */
  raw?: string;
  /** Texto na ordem de leitura física (`pdftotext`). */
  reading?: string;
  /** O Poppler existe mas falhou ao ler o PDF. */
  error?: string;
  /** Tabela do `pdffonts` (fontes do documento); ausente se ele falhou (`fontsError`). */
  fonts?: string;
  fontsError?: string;
}

export function runPoppler(bytes: Buffer, runner: PopplerRunner = defaultRunner): PopplerText {
  const probe = runner('pdftotext', ['-v'], Buffer.alloc(0));
  if (probe.status !== 0) return { available: false };
  const version = /pdftotext version ([^\s]+)/.exec(`${probe.stderr}\n${probe.stdout}`)?.[1];
  const read = (mode: 'raw' | 'reading'): RunResult =>
    runner(
      'pdftotext',
      mode === 'raw' ? ['-enc', 'UTF-8', '-raw', '-', '-'] : ['-enc', 'UTF-8', '-', '-'],
      bytes,
    );
  const raw = read('raw');
  const reading = read('reading');
  if (raw.status !== 0 || reading.status !== 0)
    return {
      available: true,
      ...(version === undefined ? {} : { version }),
      error: `pdftotext terminou com erro: ${(raw.status !== 0 ? raw : reading).stderr.trim().slice(0, 200) || 'sem mensagem'}`,
    };
  const fonts = runner('pdffonts', ['-'], bytes);
  return {
    available: true,
    ...(version === undefined ? {} : { version }),
    raw: raw.stdout,
    reading: reading.stdout,
    ...(fonts.status === 0
      ? { fonts: fonts.stdout }
      : {
          fontsError: `pdffonts terminou com erro: ${fonts.stderr.trim().slice(0, 200) || 'sem mensagem'}`,
        }),
  };
}
