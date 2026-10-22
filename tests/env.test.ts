import { describe, expect, it } from 'vitest';
import { ConfigError } from '../src/config/index.js';
import { parseEnv } from '../src/config/env.js';

describe('parseEnv', () => {
  it('usa valores padrão seguros', () => {
    const config = parseEnv({});
    expect(config.applyMode).toBe('dry-run');
    expect(config.allowAutoApply).toBe(false);
    expect(config.maxApplicationsPerDay).toBe(10);
    expect(config.databasePath).toBe('data/autoestagio.db');
  });

  it('aceita o modo manual', () => {
    expect(parseEnv({ APPLY_MODE: 'manual' }).applyMode).toBe('manual');
  });

  it('rejeita o modo auto sem a trava ALLOW_AUTO_APPLY', () => {
    expect(() => parseEnv({ APPLY_MODE: 'auto' })).toThrow(/ALLOW_AUTO_APPLY/);
  });

  it('rejeita o modo auto mesmo com a trava, pois ainda não está implementado', () => {
    expect(() => parseEnv({ APPLY_MODE: 'auto', ALLOW_AUTO_APPLY: 'true' })).toThrow(
      /ainda não foi implementado/,
    );
  });

  it('rejeita valores inválidos', () => {
    expect(() => parseEnv({ APPLY_MODE: 'turbo' })).toThrow(ConfigError);
    expect(() => parseEnv({ MAX_APPLICATIONS_PER_DAY: '-1' })).toThrow(ConfigError);
  });
});
