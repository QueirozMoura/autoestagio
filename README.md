# AutoEstágio

Sistema local para encontrar, analisar e gerenciar candidaturas a estágios em TI.
Todos os dados ficam na sua máquina (SQLite).

> **Status:** Fase 1 — Fundação. Ainda não há coleta de vagas, integração com Gmail,
> Playwright nem candidaturas. Veja o [roteiro](#roteiro).

## Requisitos

- Node.js 22 ou superior (testado com 24)
- npm
- Git

## Instalação

```bash
npm install
cp .env.example .env                              # opcional: ajuste se necessário
cp config/profile.example.json config/profile.json  # seu perfil (não vai para o Git)
npm run dev -- migrate                             # cria o banco e aplica as migrações
npm run dev -- status
```

`better-sqlite3` usa um binário nativo; em geral o npm baixa um pré-compilado. Se a
instalação falhar, instale as ferramentas de compilação (`build-essential` e `python3`).

## Comandos

| Comando                   | Descrição                                                   |
| ------------------------- | ----------------------------------------------------------- |
| `npm run dev -- status`   | Mostra modo, perfil e estado do banco (`--json` disponível) |
| `npm run dev -- migrate`  | Cria o banco e aplica migrações pendentes                   |
| `npm run build` / `start` | Compila para `dist/` e executa a versão compilada           |
| `npm test`                | Testes (Vitest)                                             |
| `npm run typecheck`       | Verificação de tipos (TypeScript strict)                    |
| `npm run lint`            | ESLint                                                      |
| `npm run format`          | Prettier                                                    |

## Configuração

Variáveis de ambiente (`.env`, validadas com Zod — veja `.env.example`):

| Variável                   | Padrão                | Descrição                            |
| -------------------------- | --------------------- | ------------------------------------ |
| `DATABASE_PATH`            | `data/autoestagio.db` | Arquivo SQLite                       |
| `PROFILE_PATH`             | `config/profile.json` | Perfil pessoal                       |
| `APPLY_MODE`               | `dry-run`             | `dry-run`, `manual` ou `auto`        |
| `ALLOW_AUTO_APPLY`         | `false`               | Trava extra para o modo `auto`       |
| `MAX_APPLICATIONS_PER_DAY` | `10`                  | Limite diário de envios (uso futuro) |

### Modos de candidatura

- **dry-run** (padrão): simula tudo, sem efeitos externos.
- **manual**: o sistema prepara e você revisa e aprova cada candidatura.
- **auto**: desabilitado e **ainda não implementado**. Quando existir, exigirá autorização
  explícita, deduplicação, limites de envio, registro de confirmação e respeito às
  permissões de cada plataforma. Hoje, `APPLY_MODE=auto` é recusado na validação.

### Perfil

`config/profile.json` (ignorado pelo Git) define formação, áreas, tecnologias, modalidades,
limite de deslocamento e bolsa mínima. Vagas sem valor de bolsa informado ficam
**pendentes de análise**. Use `config/profile.example.json` como base.

## Estrutura

```
src/
  cli/      comandos (status, migrate)
  config/   validação de .env e perfil (Zod)
  db/       conexão SQLite e migrações
  utils/
migrations/ SQL versionado (0001_*.sql, ...), com checksum
config/     perfil
data/       banco e arquivos locais (ignorados pelo Git)
tests/
```

## Roteiro

1. **Fundação** (atual)
2. Coleta: Gmail, Gupy e páginas oficiais de carreiras (Indeed, InfoJobs e LinkedIn
   depois, respeitando as permissões de cada plataforma)
3. Análise e pontuação
4. Acompanhamento de candidaturas
5. Candidatura assistida (revisão manual)
6. Modo automático e painel web
