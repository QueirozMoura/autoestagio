import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseEnv, type AppConfig } from './env.js';
import { PROJECT_ROOT, resolveFromRoot } from '../utils/paths.js';

export { ConfigError, APPLY_MODES, type ApplyMode, type AppConfig } from './env.js';
export { sha256File, verifyApprovedCv, type CvCheck, type CvReference } from './cv.js';
export {
  LANGUAGE_LEVELS,
  loadProfile,
  parseProfile,
  profileSchema,
  type LanguageLevel,
  type Profile,
} from './profile.js';

/** Carrega `.env` (se existir) sem sobrescrever variáveis já definidas no ambiente. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const envFile = resolve(PROJECT_ROOT, '.env');
  if (env === process.env && existsSync(envFile)) {
    process.loadEnvFile(envFile);
  }
  const config = parseEnv(env);
  return {
    ...config,
    databasePath: resolveFromRoot(config.databasePath),
    profilePath: resolveFromRoot(config.profilePath),
    oauthClientPath: resolveFromRoot(config.oauthClientPath),
    tokenPath: resolveFromRoot(config.tokenPath),
    emailConfigPath: resolveFromRoot(config.emailConfigPath),
    cvModelPath: resolveFromRoot(config.cvModelPath),
  };
}
