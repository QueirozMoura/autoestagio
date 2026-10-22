# Fontes de vagas: verificação e resultados

Registro do que foi verificado antes de implementar cada adaptador. Data da verificação:
**2026-10-22**. Os dados de vagas mudam todo dia; trate a lista de vagas como um retrato daquela data.

## Greenhouse (adaptador `greenhouse`)

- **Endpoint:** `GET https://boards-api.greenhouse.io/v1/boards/{board_token}/jobs` e
  `.../jobs/{id}` para o detalhe (com a descrição).
- **Acesso:** documentação oficial (<https://docs.greenhouse.io/job-board.html>): "Job Board data is
  publicly available, so authentication is not required for any GET endpoints". Só o POST de
  candidatura exige credencial, e este projeto **não o usa**.
- **robots.txt** do host (2026-10-22): `User-agent: *` / `Disallow: /embed/`. O caminho `/v1/boards/`
  é permitido.
- **Paginação:** a documentação não descreve paginação na listagem. Um quadro vem inteiro em uma
  resposta; por isso a listagem é feita sem `content` e o detalhe só é buscado para os estágios.
- **Formato:** o HTML da descrição vem escapado (`&lt;p&gt;`); o adaptador desfaz uma camada de
  escape. A API não informa modalidade de trabalho de forma estruturada.

## Lever (adaptador `lever`)

- **Endpoint:** `GET https://api.lever.co/v0/postings/{site}?mode=json&limit=N&skip=M`
  (contas europeias: `https://api.eu.lever.co`).
- **Acesso:** documentação oficial (<https://github.com/lever/postings-api>): vagas no estado
  `published` são "publicly viewable". A chave de API só é exigida na candidatura (POST), que
  este projeto **não usa**. A página avisa que vagas publicadas "may be scraped by third parties".
- **robots.txt** dos dois hosts (2026-10-22): `Allow: /` e `Crawl-delay: 1`. O intervalo padrão do
  projeto (2 s) é maior que o exigido, e o cliente HTTP aplica o `Crawl-delay` automaticamente.
- **Paginação:** `limit` e `skip` estão documentados, sem máximo declarado. O adaptador usa
  páginas de 100 e foi conferido com dados reais: `insiderone` (118 vagas) e `ciandt` (170 vagas)
  exigiram duas páginas e os totais bateram com os de uma consulta independente.
- **Formato:** traz `workplaceType` (`remote`, `hybrid`, `on-site`, `unspecified`), `country` e a
  descrição já em HTML. `unspecified` nunca é convertido em modalidade.

## O que cada adaptador faz e não faz

- Só `GET`. Sem login, sem cookies, sem chave de API, sem tocar em candidatura.
- Mesmo cliente HTTP da Etapa 2.1: ritmo por host, retry com `Retry-After`, robots.txt, HTTPS.
- 401/403 interrompem a fonte; nada é contornado.
- Guarda **somente vagas cujo título indica estágio** (`estágio`, `estagiário`, `intern`,
  `internship`) e, por padrão, **somente no Brasil/LATAM** (`brazilOnly`). `Trainee` e `Jovem
Aprendiz` ficam de fora de propósito: não servem para quem cursa graduação.
- Cada fonte falha de forma isolada e registra a categoria do erro em `scan_runs`.

## Pesquisa de empresas (2026-10-22)

Método: busca na web restrita aos domínios das plataformas e consulta, uma vez por empresa, à
API pública (≈ 80 quadros candidatos; 404 = a empresa não usa a plataforma com aquele token).
**Resultado: vagas de estágio em TI no Brasil são escassas nessas duas plataformas.** Muitas
empresas brasileiras de tecnologia usam Gupy (Etapa 2.5) ou páginas próprias.

Quadros que têm estágio no Brasil hoje:

| Empresa                             | Plataforma | Página de carreiras                                              | Estágios no Brasil                                                   | TI?                          |
| ----------------------------------- | ---------- | ---------------------------------------------------------------- | -------------------------------------------------------------------- | ---------------------------- |
| Shift Technology                    | Greenhouse | <https://job-boards.greenhouse.io/shifttechnology>               | Data Scientist Intern (English Speaker)                              | **Sim**                      |
| Agilize                             | Greenhouse | <https://job-boards.greenhouse.io/agilize>                       | Programa de Estágio em Contabilidade e IA 2026.2                     | Parcial (contabilidade + IA) |
| Insider One                         | Lever      | <https://jobs.lever.co/insiderone>                               | Customer Onboarding Intern; Workplace & Experience Intern            | Não (Customer Success e RH)  |
| Wildlife Studios                    | Greenhouse | <https://job-boards.greenhouse.io/wildlifestudios>               | Audio Design, Creative Strategy, Social Media e UGC Creative Intern  | Não                          |
| XP Inc.                             | Greenhouse | <https://job-boards.greenhouse.io/xpinc>                         | Estagiário(a) \| Corporate Desk                                      | Não                          |
| XP Inc. (Candidaturas Direcionadas) | Greenhouse | <https://job-boards.greenhouse.io/candidaturasdirecionadasxpinc> | Estágio em RPPS; Comercial e Wealth Management; Pré-inscrição 2026.1 | Não                          |

Quadros consultados sem estágio no Brasil no momento: Wellhub/Gympass (só "Jovem Aprendiz"),
CI&T, VTEX, QuintoAndar, Stone, EBANX, Jusbrasil, Thoughtworks e outros.

## Validação com dados reais (2026-10-22)

Coleta limitada (≤ 20 vagas e ≤ 3 páginas por fonte, 1 requisição a cada 2 s por host), somente
leitura, 8 fontes: **570 vagas listadas → 20 com título de estágio → 12 no Brasil → 12 gravadas**,
das quais **1 é de TI**. Nenhum erro e nenhuma falha de gravação.
