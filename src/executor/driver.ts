import type { FormModel, PageSignals } from './types.js';

/**
 * Contrato mínimo do navegador. PROPOSITALMENTE sem "clicar" nem "enviar": o executor só abre, lê, preenche, seleciona
 * uma opção, anexa um arquivo e tira uma captura. É isso que garante, no tipo, que ele nunca envia uma candidatura.
 */
export interface PageDriver {
  goto(url: string): Promise<void>;
  signals(): Promise<PageSignals>;
  extractForm(): Promise<FormModel>;
  /** Preenche e devolve o valor lido de volta da página. */
  fill(selector: string, value: string): Promise<string>;
  /** Escolhe a opção pelo texto e devolve o texto selecionado. */
  select(selector: string, optionLabel: string): Promise<string>;
  /** Anexa o arquivo e devolve o nome que a página registrou. */
  upload(selector: string, filePath: string): Promise<string>;
  screenshot(path: string): Promise<void>;
  /** Texto atual da página (para procurar a confirmação depois que VOCÊ enviar). */
  text(): Promise<string>;
  close(): Promise<void>;
}

export interface BrowserSession {
  newPage(): Promise<PageDriver>;
  close(): Promise<void>;
}

export class ExecutorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExecutorError';
  }
}

/** Só HTTPS e sem credenciais embutidas na URL. */
export function assertSafeUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ExecutorError('URL de candidatura inválida.');
  }
  if (url.protocol !== 'https:') throw new ExecutorError('A candidatura só abre links HTTPS.');
  if (url.username !== '' || url.password !== '')
    throw new ExecutorError('O link não pode conter credenciais.');
  return url;
}
