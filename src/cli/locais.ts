import type { Command } from 'commander';
import { loadConfig, loadProfile } from '../config/index.js';
import type { Db } from '../db/index.js';
import { CommuteError, pendingLocations, registerCommute } from '../eligibility/locations.js';

interface Deps {
  withDb: <T>(fn: (db: Db) => T) => T;
}

/** Deslocamento: lista os locais sem tempo confirmado e registra os tempos que VOCÊ confirmou. Nada é estimado. */
export function registerLocationCommands(program: Command, { withDb }: Deps): void {
  const locais = program
    .command('locais')
    .description(
      'Tempos de deslocamento confirmados por você (nada é estimado nem calculado por distância)',
    );

  locais
    .command('pendentes')
    .description(
      'Locais de vagas presenciais/híbridas ainda sem tempo confirmado (para você conferir no Google Maps)',
    )
    .option('--json', 'saída em JSON')
    .action((options: { json?: boolean }) => {
      const config = loadConfig();
      const profile = loadProfile(config.profilePath);
      if (profile === undefined) throw new Error('Perfil não encontrado.');
      const list = withDb((db) => pendingLocations(db, profile));
      if (options.json === true) {
        console.log(JSON.stringify(list, null, 2));
        return;
      }
      const origin = profile.home?.label ?? 'sua referência';
      console.log(
        list.length === 0
          ? 'Nenhum local pendente.'
          : [
              `Locais sem tempo confirmado (confira o trajeto por transporte público a partir de ${origin}):`,
              ...list.map(
                (l) => `  ${String(l.jobs).padStart(3)} vaga(s)  ${l.location}  [${l.region}]`,
              ),
              '',
              'Registre cada um: locais registrar --palavras "<bairro,empresa>" --minutos <N> --fonte "Google Maps, transporte público"',
            ].join('\n'),
      );
    });

  locais
    .command('registrar')
    .description(
      'Registra no perfil um tempo de deslocamento confirmado por você (com fonte e data)',
    )
    .requiredOption(
      '--palavras <lista>',
      'palavras que identificam o local na vaga, separadas por vírgula',
    )
    .requiredOption(
      '--minutos <n>',
      'minutos por trecho (transporte público), confirmados por você',
    )
    .requiredOption(
      '--fonte <texto>',
      'como foi verificado (ex.: "Google Maps, transporte público")',
    )
    .option('--data <AAAA-MM-DD>', 'data da confirmação (padrão: hoje)')
    .action((options: { palavras: string; minutos: string; fonte: string; data?: string }) => {
      const config = loadConfig();
      try {
        const result = registerCommute(config.profilePath, {
          keywords: options.palavras.split(','),
          minutesPerWay: Number(options.minutos),
          source: options.fonte,
          confirmedAt: options.data,
        });
        console.log(
          `${result.replaced ? 'Tempo atualizado' : 'Tempo registrado'}: ${options.palavras} = ${options.minutos} min por trecho. O perfil mudou: rode "analyze" para refazer a classificação. (Cópia de segurança do perfil: .pre-locais.bak.)`,
        );
      } catch (error) {
        if (error instanceof CommuteError) throw new Error(error.message, { cause: error });
        throw error;
      }
    });
}
