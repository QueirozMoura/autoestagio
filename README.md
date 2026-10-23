# AutoEstágio

Sistema local para encontrar, analisar e gerenciar candidaturas a estágios em TI.
Todos os dados ficam na sua máquina (SQLite).

> **Objetivo e critérios de aceitação:** veja [docs/ACCEPTANCE.md](docs/ACCEPTANCE.md).
>
> **Status:** Fase 2 em andamento. Já há coleta real e somente leitura em Greenhouse e Lever
> (veja [docs/SOURCES.md](docs/SOURCES.md)). Ainda não há Gmail, Playwright nem candidaturas.
> Veja o [roteiro](#roteiro).

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

| Comando                                | Descrição                                                                                 |
| -------------------------------------- | ----------------------------------------------------------------------------------------- |
| `npm run dev -- status`                | Mostra modo, perfil e estado do banco (`--json` disponível)                               |
| `npm run dev -- migrate`               | Cria o banco e aplica migrações pendentes                                                 |
| `npm run dev -- scan`                  | Coleta estágios nas fontes de `config/sources.json` (Greenhouse e Lever), somente leitura |
| `npm run dev -- scan --simulate`       | Coleta simulada com fontes fictícias, sem rede (veja abaixo)                              |
| `npm run dev -- cv variants`           | Lista as variantes do currículo (estado editorial, elegibilidade, pré-condições)          |
| `npm run dev -- cv generate`           | Gera e grava o PDF de uma variante pelo fluxo estrito (veja `docs/CV_GENERATE.md`)        |
| `npm run dev -- email export-eml <id>` | Exporta um rascunho local `.eml` (sem enviar nada; veja `docs/EMAIL.md`)                  |
| `npm run build` / `start`              | Compila para `dist/` e executa a versão compilada                                         |
| `npm test`                             | Testes (Vitest)                                                                           |
| `npm run typecheck`                    | Verificação de tipos (TypeScript strict)                                                  |
| `npm run lint`                         | ESLint                                                                                    |
| `npm run format`                       | Prettier                                                                                  |

## Currículos em PDF (fluxo estrito)

```bash
npm run dev -- cv variants --ancora-sha256 <hash>
npm run dev -- cv generate --variant desenvolvimento --ancora-sha256 <hash> [--output <diretório>]
```

O PDF só é gravado se a validação estrita estiver completa; nunca sobrescreve arquivos e vai, por
padrão, para `data/cv-output/` (ignorado pelo Git, modo 0700). Detalhes, pré-requisitos, erros e
limites de segurança: [docs/CV_GENERATE.md](docs/CV_GENERATE.md).

## Scan real (somente leitura)

```bash
cp config/sources.example.json config/sources.json   # depois adicione seus alvos (arquivo local, fora do Git)
npm run dev -- migrate
npm run dev -- scan                              # todas as fontes habilitadas
npm run dev -- scan --source greenhouse:agilize  # só uma
```

Cada alvo é `{ "kind": "greenhouse" | "lever", "slug": "...", "name": "..." }`, em que `slug` é o
token do quadro (a parte final de `job-boards.greenhouse.io/<slug>` ou `jobs.lever.co/<slug>`).
O scan só faz `GET` nas APIs públicas e documentadas, respeita o `robots.txt`, limita o ritmo por host
e **não envia nada**. Guarda apenas vagas de estágio (por padrão, só no Brasil; use `"brazilOnly": false`
para mudar) e grava no banco real. Falhas de uma fonte não afetam as outras.

## Scan simulado

Nesta etapa só existe o modo simulado: fontes e vagas fictícias, **nenhuma requisição de rede**.

```bash
npm run dev -- scan --simulate              # roda em memória; nada é gravado em disco
npm run dev -- scan --simulate --repeat 2   # a 2ª execução não cria nem altera nada (idempotência)
npm run dev -- scan --simulate --db-file /tmp/sim.db   # guarda em um arquivo de teste
```

A simulação **nunca grava no banco real** (`DATABASE_PATH`), para não misturar vagas fictícias com
as reais. Depois de atualizar o projeto, rode `npm run dev -- migrate` para aplicar as migrações novas.

### Como as vagas são deduplicadas

Uma vaga é considerada a mesma, em ordem de força da evidência:

1. **Mesma fonte e mesmo identificador externo.** Dentro de uma fonte, ids diferentes são sempre
   vagas diferentes.
2. **URL canônica igual** (sem parâmetros de rastreamento, fragmento, `www.` ou barra final) **e**
   título quase idêntico.
3. **Empresa + título + local iguais _e_ descrição praticamente idêntica.** Empresa, título e
   cidade, sozinhos, nunca provam duplicidade: sem a descrição, o par só é **sinalizado** em
   `job_possible_duplicates` para revisão.

Limitação conhecida: a deduplicação é incremental e não une vagas já gravadas (isso poderia quebrar
análises e candidaturas que as referenciam). Se uma vaga nova ligar duas vagas que já estavam
separadas, o par é sinalizado em vez de unido, e o resultado pode depender da ordem das fontes.

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
  http/     cliente HTTP (timeout, retry, rate limit por host, robots.txt)
  sources/  contratos dos adaptadores, configuração e registro de fontes
  discovery/ normalização, deduplicação, persistência e scan
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
