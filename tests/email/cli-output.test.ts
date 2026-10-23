import { beforeEach, describe, expect, it } from 'vitest';
import { IN_MEMORY, openDatabase, runMigrations } from '../../src/db/index.js';
import { formatDispatches, formatDryRun } from '../../src/cli/email.js';
import { dryRunEmail, listDispatches, loadEmailConfig, sendEmail } from '../../src/email/index.js';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CV_SHA, RECIPIENT, authorizeConfirmed, setupApproved } from '../helpers/email.js';

let s: ReturnType<typeof setupApproved>;
beforeEach(() => {
  const db = openDatabase(IN_MEMORY);
  runMigrations(db);
  s = setupApproved(db);
});

describe('saída da CLI de e-mail', () => {
  it('o ensaio deixa claro que nada foi enviado e mascara o destinatário', () => {
    const text = formatDryRun(dryRunEmail(s.ctx, s.applicationId), s.applicationId, 'real');
    expect(text).toContain('NADA FOI ENVIADO');
    expect(text).toContain('r***@acme-ficticia.com.br');
    expect(text).toContain('[ok]');
    expect(text).toContain('falta só a sua autorização');
    expect(text).not.toContain(RECIPIENT);
    expect(text).not.toContain(CV_SHA);
    expect(text).not.toContain('Olá, equipe'); // o corpo da mensagem não é impresso
  });

  it('trava mestra desligada e verificações falhando aparecem de forma distinta', () => {
    const off = formatDryRun(
      dryRunEmail({ ...s.ctx, sendEnabled: false }, s.applicationId),
      s.applicationId,
      'real',
    );
    expect(off).toContain('[AVISO] envio_habilitado');
    expect(off).toContain('EMAIL_SEND_ENABLED=false');
    s.cv.bytes = Buffer.from('%PDF-1.4 outro');
    const bad = formatDryRun(dryRunEmail(s.ctx, s.applicationId), s.applicationId, 'real');
    expect(bad).toContain('[FALHA] curriculo_confere');
    expect(bad).toContain('Mensagem não montada');
  });

  it('o status mostra as três confirmações separadas e nenhum dado sensível', async () => {
    const auth = authorizeConfirmed(s.ctx, s.applicationId, 'real', 'ok');
    await sendEmail(s.ctx, s.applicationId, auth.id, 'real');
    const text = formatDispatches(listDispatches(s.db, s.applicationId));
    expect(text).toContain('aceito pelo Gmail:           sim');
    expect(text).toContain('entrega confirmada:          não');
    expect(text).toContain('recebimento pela empresa:    não');
    expect(text).toContain('id do Gmail: registrado');
    expect(text).not.toMatch(/fake-1|rfc|<.*@/);
    expect(text).not.toContain(RECIPIENT);
  });
});

describe('loadEmailConfig (caixa de teste)', () => {
  it('lê e normaliza a caixa de teste; arquivo ausente = sem caixa; inválido = erro', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cfg-'));
    try {
      expect(loadEmailConfig(join(dir, 'nao-existe.json'))).toEqual({});
      const ok = join(dir, 'email.json');
      writeFileSync(ok, JSON.stringify({ testMailbox: ' Minha.Caixa@Exemplo.ORG ' }));
      expect(loadEmailConfig(ok)).toEqual({ testMailbox: 'minha.caixa@exemplo.org' });
      writeFileSync(ok, JSON.stringify({ testMailbox: 'invalido' }));
      expect(() => loadEmailConfig(ok)).toThrow(/inválida/);
      writeFileSync(ok, '{');
      expect(() => loadEmailConfig(ok)).toThrow(/JSON válido/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
