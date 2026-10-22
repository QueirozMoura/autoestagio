import { resolve } from 'node:path';
import { HttpClient } from '../http/index.js';
import { IN_MEMORY, openDatabase, runMigrations } from '../db/index.js';
import { createSourceContext, parseSourcesConfig } from '../sources/index.js';
import { runScan, type ScanReport } from './scan.js';
import { createSimulatedSources } from './simulated.js';

export interface SimulationOptions {
  /** Arquivo SQLite onde guardar o resultado; sem ele, tudo fica em memória e é descartado. */
  dbFile?: string | undefined;
  /** Banco real do sistema, que a simulação nunca pode tocar. */
  protectedDbPath?: string | undefined;
  repeat?: number | undefined;
}

export class SimulationError extends Error {}

/** Cliente que recusa qualquer requisição: o modo simulado não usa a rede. */
function offlineHttpClient(): HttpClient {
  return new HttpClient({
    fetch: () => Promise.reject(new Error('rede desabilitada no modo simulado')),
    maxRetries: 0,
  });
}

/**
 * Executa o scan com as fontes fictícias. Por padrão usa um banco em memória, para que dados de
 * teste nunca se misturem às vagas reais.
 */
export async function runSimulation(options: SimulationOptions = {}): Promise<ScanReport[]> {
  const repeat = options.repeat ?? 1;
  if (!Number.isInteger(repeat) || repeat < 1 || repeat > 10) {
    throw new SimulationError('--repeat deve ser um inteiro entre 1 e 10');
  }
  if (
    options.dbFile !== undefined &&
    options.protectedDbPath !== undefined &&
    resolve(options.dbFile) === resolve(options.protectedDbPath)
  ) {
    throw new SimulationError(
      'A simulação não pode gravar no banco real; use outro arquivo em --db-file',
    );
  }

  const db = openDatabase(options.dbFile === undefined ? IN_MEMORY : resolve(options.dbFile));
  try {
    runMigrations(db);
    const config = parseSourcesConfig({});
    const context = createSourceContext(config, { http: offlineHttpClient() });
    const reports: ScanReport[] = [];
    for (let run = 0; run < repeat; run++) {
      reports.push(
        await runScan({ db, sources: createSimulatedSources(), context, simulated: true }),
      );
    }
    return reports;
  } finally {
    db.close();
  }
}
