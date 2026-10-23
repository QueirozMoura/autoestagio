import { loadConfig, loadProfile } from '../config/index.js';
import type { StrictInputsOptions } from '../cv/strict-inputs.js';

/** Opções do carregador estrito a partir da configuração real; a âncora vem sempre do operador. */
export function strictInputsOptions(anchorSha256: string | undefined): StrictInputsOptions {
  const config = loadConfig();
  const approval = loadProfile(config.profilePath)?.approval;
  return {
    modelPath: config.cvModelPath,
    masterPdf:
      approval === undefined ? undefined : { path: approval.cvFile, sha256: approval.cvSha256 },
    anchorSha256,
  };
}
