import { GreenhouseSource } from './greenhouse.js';
import { LeverSource } from './lever.js';
import { SourceRegistry } from './registry.js';

/**
 * Registro com os adaptadores disponíveis. Só entram aqui fontes cujo endpoint e cujas regras de
 * acesso foram verificados (veja docs/SOURCES.md).
 */
export function createDefaultRegistry(): SourceRegistry {
  return new SourceRegistry()
    .register('greenhouse', (target) => new GreenhouseSource(target))
    .register('lever', (target) => new LeverSource(target));
}
