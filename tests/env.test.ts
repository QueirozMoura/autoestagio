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

  it('exige AUTO_APPLY=real mesmo com ALLOW_AUTO_APPLY', () => {
    expect(() => parseEnv({ APPLY_MODE: 'auto', ALLOW_AUTO_APPLY: 'true' })).toThrow(
      /AUTO_APPLY=real/,
    );
  });

  it('rejeita valores inválidos', () => {
    expect(() => parseEnv({ APPLY_MODE: 'turbo' })).toThrow(ConfigError);
    expect(() => parseEnv({ MAX_APPLICATIONS_PER_DAY: '-1' })).toThrow(ConfigError);
  });
});

describe('parseEnv — canal de e-mail', () => {
  it('o envio de e-mails vem DESLIGADO por padrão e os caminhos têm padrão seguro', () => {
    const config = parseEnv({});
    expect(config.emailSendEnabled).toBe(false);
    expect(config.tokenPath).toBe('data/gmail-token.json');
    expect(config.oauthClientPath).toBe('config/google-oauth-client.json');
    expect(config.emailConfigPath).toBe('config/email.json');
  });

  it('só liga com "true" explícito; outros valores são recusados', () => {
    expect(parseEnv({ EMAIL_SEND_ENABLED: 'true' }).emailSendEnabled).toBe(true);
    expect(() => parseEnv({ EMAIL_SEND_ENABLED: 'sim' })).toThrow(ConfigError);
    expect(() => parseEnv({ EMAIL_SEND_ENABLED: '1' })).toThrow(ConfigError);
  });

  it('ligar o e-mail não substitui a opção explícita AUTO_APPLY', () => {
    expect(() =>
      parseEnv({ APPLY_MODE: 'auto', ALLOW_AUTO_APPLY: 'true', EMAIL_SEND_ENABLED: 'true' }),
    ).toThrow(/AUTO_APPLY=real/);
  });
});

describe('parseEnv — modelo mestre do currículo', () => {
  it('o caminho do modelo tem padrão em config/ (fora do Git) e pode ser sobrescrito', () => {
    expect(parseEnv({}).cvModelPath).toBe('config/cv-master.json');
    expect(parseEnv({ CV_MODEL_PATH: 'x/y.json' }).cvModelPath).toBe('x/y.json');
  });
});

describe('AUTO_APPLY', () => {
  it('fica desligado por padrão e simulação não exige habilitar envio', () => {
    expect(parseEnv({}).autoApplyMode).toBe('off');
    expect(parseEnv({ AUTO_APPLY: 'simulate' }).autoApplyMode).toBe('simulate');
  });
  it('aceita modo real apenas com opt-in explícito, sem ligar e-mail por conta própria', () => {
    expect(() => parseEnv({ AUTO_APPLY: 'real' })).toThrow(/ALLOW_AUTO_APPLY/);
    const config = parseEnv({ APPLY_MODE: 'auto', AUTO_APPLY: 'real', ALLOW_AUTO_APPLY: 'true' });
    expect(config.applyMode).toBe('auto');
    expect(config.emailSendEnabled).toBe(false);
  });
});
