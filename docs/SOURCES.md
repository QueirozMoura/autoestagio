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

## Ashby (adaptador `ashby`)

- **Endpoint:** `GET https://api.ashbyhq.com/posting-api/job-board/{JOB_BOARD_NAME}?includeCompensation=true`
  (o nome é o último trecho de `jobs.ashbyhq.com/{nome}`; é sensível a maiúsculas na URL exibida,
  mas a API respondeu igual nos testes). Um quadro vem inteiro em uma resposta, sem paginação.
- **Acesso:** documentação oficial (<https://developers.ashbyhq.com/docs/public-job-posting-api>).
  Não documenta autenticação nem limites de taxa; na prática, as respostas foram `200` sem
  credenciais e `404` para quadros inexistentes. O projeto mantém 1 requisição a cada 2 s por host.
- **robots.txt:** `api.ashbyhq.com/robots.txt` responde `401` (2026-10-22), tratado como "sem arquivo"
  (RFC 9309, 4xx). O `jobs.ashbyhq.com/robots.txt` (outro host) bloqueia `/api/`, o que não
  afeta o endpoint usado aqui.
- **Formato:** `jobs[]` com `title`, `location`, `secondaryLocations`, `address.postalAddress`,
  `isListed`, `isRemote`, `workplaceType` (`OnSite`/`Remote`/`Hybrid`), `employmentType`
  (`FullTime`/`PartTime`/`Intern`/`Contract`/`Temporary`), `descriptionHtml`/`descriptionPlain`,
  `publishedAt`, `jobUrl`, `applyUrl` e `compensation` (dentro de cada vaga, não no topo).
- **Regras do adaptador:** estágio = `employmentType == Intern` **ou** título de estágio (há
  quadros em que "Product Intern" vem como `FullTime`); `isListed: false` é descartado; campo
  ausente nunca vira valor presumido; `applyUrl` é guardado em `jobs.apply_url` (migração 0003).
- **Lição:** o `User-Agent` precisa ser ASCII. Com acentos o WAF (Cloudflare) devolvia 403 ao
  cliente Node; o `User-Agent` do projeto foi corrigido (continua identificando o projeto).

Quadros verificados (200) em 2026-10-22: `enter-ai`, `nubank`, `Skydropx`, `double`, `canals`,
`Luzid`, `telepatia`. Estágio no Brasil hoje: **só a Enter** (Programa de Estágio 2027 e
Product Intern, ambos em São Paulo, presenciais). O Nubank tem 1 `Intern`, mas nos EUA; o
Programa de Estágio Nubank 2027 e o estágio de TI da Skydropx/Frenet, vistos em buscas, **não
estão mais na API**. Slugs testados e inexistentes (404): quintoandar, vtex, ebanx, creditas,
cloudwalk, hotmart, dock, pagarme, agibank, clara, kovi, frenet; `loft`, `neon` e `deel` existem
mas não têm estágio.

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

## Leads de alertas (Indeed, LinkedIn) e quadros públicos

- **Leads** (`leads add|import|list|set`, tabela `job_leads`, migração 0010) são **pistas**, não vagas oficiais nem candidaturas, e não autorizam nenhum envio:
  não há ligação com `jobs`, `applications` nem com o canal de e-mail. O canal de candidatura começa "desconhecido" e só você o confirma, na página oficial.
  O endereço do remetente de um alerta nunca é destinatário. A avaliação de um lead nunca é "apto".
- **Links de alerta** são pessoais: a aplicação remove query e fragmento; prefira o link oficial da empresa.
- **Quadros públicos verificados em 2026-10-23** (Greenhouse, Lever, Ashby; só leitura): para 25 nomes de empresas vistas nos alertas (Mottu, Medway, Kolab, Solví,
  Holos Media, Giant Steps, SONDA, Apsis, Vonex, Shakers, Timbro, Diebold, Lilly, TOTVS, Serasa Experian, BairesDev, Dr. Tis, NCS, Itaú, Vale, Bayer, BASF, Danone, Mercedes-Benz),
  **nenhum** quadro foi encontrado com o `slug` óbvio (o método foi validado com um quadro conhecido). Nada foi acrescentado a `config/sources.json`: não se inventam `slug`s.
  Essas empresas provavelmente usam outras plataformas (Gupy, Workday, Cia de Talentos).
- **Gupy:** `portal.gupy.io/robots.txt` não restringe rastreadores e `portal.api.gupy.io` não publica `robots.txt`, mas a API do portal não é documentada
  para uso público e os termos de uso não foram verificados. **Não foi implementado adaptador.** Alternativa segura: registrar vagas da Gupy como leads manualmente.

## Expansão da descoberta (2026-10-24)

Sondagem de ≈ 200 slugs de empresas brasileiras nas APIs públicas já aprovadas (Greenhouse, Lever, Ashby), com
1 requisição por segundo, só GET. Resultado, medido com o filtro de estágio do projeto:

| Alvo (Greenhouse)      | Estágios no Brasil | Observação                                                                    |
| ---------------------- | -----------------: | ----------------------------------------------------------------------------- |
| `btgpactual`           |                  8 | Maioria fora de TI; "Short Job – Automation" e programas gerais               |
| `c6bank`               |                  6 | Programas gerais e áreas de negócio; o texto cita "100% presencial, Jardins"  |
| `inter`                |                  4 | Parte em Belo Horizonte (fora da região); programa geral de banco de talentos |
| `stone`, `quintoandar` |                  0 | Existem na plataforma, mas sem estágio no momento                             |

Investigadas e **não adotadas**:

- **Gupy** (maior volume de estágios): o endpoint do portal não é documentado e os termos de uso não foram
  verificados; a candidatura exige login. Fica fora até haver revisão dos termos.
- **Repositórios de vagas no GitHub** (`frontendbr/vagas` etc.): API pública e documentada, mas só 1 vaga marcada
  como estágio entre os repositórios testados, e o rótulo é pouco confiável (a vaga marcada era Sênior).
- **SmartRecruiters**, **Inhire**: sem estágio relevante nos slugs testados / candidatura por formulário com
  reCAPTCHA (nada a automatizar).

Lições: a maioria dos estágios encontrados é de programas gerais de bancos, **sem área, bolsa ou modalidade na
vaga**. O extrator agora lê frases declarativas da descrição ("modelo 100% presencial", "estagiar presencialmente") e
o bairro/rua escritos ("na região dos Jardins"), sem deduzir nada. Use `autonomo sources` para medir cada fonte.
