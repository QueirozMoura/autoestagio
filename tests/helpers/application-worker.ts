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
import { prepareApplication } from '../../src/preparation/index.js';
import { CV, PREP_CV, PROFILE_HASH } from './applications.js';
import { NOW, profile } from './eligibility.js';

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
