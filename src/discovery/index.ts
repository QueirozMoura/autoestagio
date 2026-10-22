export { canonicalizeUrl, InvalidJobUrlError } from './url.js';
export {
  NormalizationError,
  normalizeJob,
  type NormalizedJob,
  type WorkMode,
} from './normalize.js';
export { judge, type DedupeCandidate, type DedupeIncoming, type Verdict } from './dedupe.js';
export { ingestJob, type IngestAction, type IngestResult } from './ingest.js';
export { JobStore, type RunCounters } from './store.js';
export { runScan, type ScanOptions, type ScanReport, type SourceScanReport } from './scan.js';
export { createSimulatedSources } from './simulated.js';
export { runSimulation, SimulationError, type SimulationOptions } from './simulate.js';
