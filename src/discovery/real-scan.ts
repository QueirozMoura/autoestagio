import type { Db } from '../db/index.js';
import type { HttpClient } from '../http/index.js';
import {
  SourceConfigError,
  createDefaultRegistry,
  createSourceContext,
  type SourceRegistry,
  type SourcesConfig,
} from '../sources/index.js';
import { runScan, type ScanReport } from './scan.js';

export interface RealScanOptions {
  db: Db;
  config: SourcesConfig;
  /** Restringe a alguns alvos, no formato "kind:slug". */
  only?: readonly string[] | undefined;
  registry?: SourceRegistry | undefined;
  /** Permite injetar o cliente HTTP (testes). */
  http?: HttpClient | undefined;
  signal?: AbortSignal | undefined;
  now?: (() => Date) | undefined;
}

/**
 * Coleta nas fontes configuradas (somente leitura nas plataformas) e grava no SQLite. Os limites
 * de vagas, páginas e ritmo de requisições vêm da configuração de fontes.
 */
export async function runRealScan(options: RealScanOptions): Promise<ScanReport> {
  const registry = options.registry ?? createDefaultRegistry();
  const wanted = options.only?.map((key) => key.toLowerCase());

  const targets = options.config.targets.filter(
    (target) =>
      wanted === undefined || wanted.includes(`${target.kind}:${target.slug}`.toLowerCase()),
  );
  if (wanted !== undefined) {
    const known = new Set(targets.map((target) => `${target.kind}:${target.slug}`.toLowerCase()));
    const missing = wanted.filter((key) => !known.has(key));
    if (missing.length > 0) {
      throw new SourceConfigError(
        `Fonte(s) não encontrada(s) na configuração: ${missing.join(', ')}`,
      );
    }
  }

  const sources = registry.create({ targets });
  if (sources.length === 0) {
    throw new SourceConfigError(
      'Nenhuma fonte habilitada. Configure alvos em config/sources.json (veja config/sources.example.json).',
    );
  }

  const context = createSourceContext(options.config, {
    ...(options.http && { http: options.http }),
    ...(options.signal && { signal: options.signal }),
  });
  return runScan({
    db: options.db,
    sources,
    context,
    ...(options.now && { now: options.now }),
  });
}
