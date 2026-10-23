/**
 * Processo-filho dos testes de concorrência: abre o MESMO arquivo SQLite que o processo de teste
 * e executa uma ação. Imprime uma linha JSON com o resultado.
 *   uso: node --import tsx application-worker.ts <arquivo.db> <ação> <argumentos...>
 */
import {
  ApplicationError,
  createApplication,
  transitionApplication,
} from '../../src/applications/index.js';
import { openDatabase } from '../../src/db/index.js';
import { appendFileSync } from 'node:fs';
import { sendEmail, type EmailContext } from '../../src/email/index.js';
import { prepareApplication } from '../../src/preparation/index.js';
import { CV, PREP_CV, PROFILE_HASH } from './applications.js';
import { NOW, profile } from './eligibility.js';
import { CV_BYTES, emailProfile } from './email.js';

const [dbPath, action, ...args] = process.argv.slice(2);
if (dbPath === undefined || action === undefined) throw new Error('uso inválido');
const db = openDatabase(dbPath);

try {
  if (action === 'create') {
    const result = createApplication(db, {
      jobId: Number(args[0]),
      cv: CV,
      profileHash: PROFILE_HASH,
      channel: 'email',
    });
    console.log(
      JSON.stringify({
        created: result.created,
        reason: 'reason' in result ? result.reason : null,
      }),
    );
  } else if (action === 'prepare') {
    const result = prepareApplication(db, {
      profile: profile(),
      cv: PREP_CV,
      jobId: Number(args[0]),
      channel: 'manual',
      now: NOW,
    });
    console.log(
      JSON.stringify({
        outcome: result.outcome,
        applicationId: 'applicationId' in result ? result.applicationId : null,
      }),
    );
  } else if (action === 'email-send' || action === 'email-send-crash') {
    // Gmail simulado: cada chamada de envio vira uma linha no arquivo de log (o "e-mail que saiu").
    const logFile = args[2] ?? '';
    const ctx: EmailContext = {
      db,
      profile: emailProfile(),
      sendEnabled: true,
      maxPerDay: 10,
      readCv: () => CV_BYTES,
      // args[3]: deslocamento opcional do relógio, em minutos (cenários de limites de tempo).
      now: () => new Date(NOW.getTime() + Number(args[3] ?? 0) * 60_000),
      transport: {
        send: () => {
          appendFileSync(logFile, `saiu pid=${process.pid}\n`);
          if (action === 'email-send-crash') process.exit(137); // cai logo depois de o Gmail "aceitar"
          return Promise.resolve({
            kind: 'accepted',
            messageId: `fake-${process.pid}`,
            threadId: undefined,
            labelIds: [],
          });
        },
      },
    };
    const result = await sendEmail(ctx, Number(args[0]), Number(args[1]), 'real');
    console.log(JSON.stringify({ outcome: result.outcome }));
  } else if (action === 'send' || action === 'reserve-and-crash') {
    const result = transitionApplication(db, Number(args[0]), {
      to: 'enviando',
      reason: `worker ${process.pid}`,
      ...(args[1] === undefined ? {} : { idempotencyKey: args[1] }),
    });
    console.log(JSON.stringify({ changed: result.changed }));
    if (action === 'reserve-and-crash') process.exit(137); // cai logo depois de reservar o envio
  }
} catch (error) {
  console.log(
    JSON.stringify({ error: error instanceof ApplicationError ? error.code : String(error) }),
  );
} finally {
  db.close();
}
