# Plataformas de emprego: auditoria de termos e viabilidade de automação

Auditoria feita em **2026-10-24 (horário de São Paulo; alguns registros em UTC são de 25/10)**, lendo os termos e o `robots.txt` reais de cada plataforma (somente leitura, sem login e
sem enviar nada). Não é aconselhamento jurídico: o que vale é o texto vigente dos termos de cada plataforma. Regra do
projeto: **só se automatiza onde os termos não proíbem**; nada é contornado (CAPTCHA, login, limites) e nenhuma avaliação é
respondida pelo agente.

| Plataforma      | O que os termos dizem sobre automação                                                                                                                                                                                                                                                          | Decisão                                                |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| LinkedIn        | Contrato do usuário, seção 8.2: proíbe scripts, robôs e **extensões de navegador** para copiar os serviços, bots para acessar os serviços ou agir (mensagens, publicações) e burlar limites. O `robots.txt` repete a proibição.                                                                | **Bloqueada** (descoberta e candidatura)               |
| Indeed          | Termos para Candidatos, item 3.5: proíbe automação, script ou bot para automatizar a candidatura, salvo pelas ferramentas oficiais do Indeed.                                                                                                                                                  | **Bloqueada** para candidatura automatizada            |
| Catho           | Termos de uso (`/pagamento-candidato/termos-de-uso`): proíbe acesso por método diferente da interface e uso de scripts, robôs, crawlers e _data scraping_. O site também recusa leitura automática (HTTP 403).                                                                                 | **Bloqueada**                                          |
| InfoJobs        | Aviso Legal para Candidatos, obrigações do usuário, item 4: proíbe mecanismos, software e scripts e cópia por robôs/crawlers, salvo autorização expressa.                                                                                                                                      | **Bloqueada**                                          |
| Sólides         | A política de privacidade foi localizada: não cita robôs, scripts nem automação (seção 15 veda reproduzir o conteúdo sem autorização). Os termos específicos do portal não ficaram esclarecidos; os termos da loja tratam de contrato com o cliente. `robots.txt`: `User-agent: * / Allow: /`. | **Sem coleta; protótipo exclusivamente offline**       |
| Cia de Talentos | O "Termos de uso" é o aceite de LGPD, sem cláusula de automação. A plataforma gira em torno de cadastro com CPF e **avaliações** (assessment), que o agente não responde.                                                                                                                      | **Inconclusiva; candidatura depende de avaliação sua** |

## Sólides: observações históricas, sem autorização de coleta

- A página pública de busca consulta uma API do mesmo domínio:
  `GET https://vagas.solides.com.br/api/vacancies?page=1&take=14&title=<busca>&locations=<cidade - UF>`
  (resposta `{count, currentPage, totalPages, data[]}`; `take` acima de 14 devolve erro). Em consulta anterior: 205 vagas, 15 páginas. Não reconsultado nesta etapa; não é API pública documentada nem autorização de uso.
- Cada vaga traz dados **estruturados** que as outras fontes não têm: `jobType` (presencial/híbrido/remoto), `homeOffice`,
  endereço com bairro e rua, faixa salarial quando divulgada, `type` (externa, interna ou mista), `killerQuestions`,
  `affirmative`/`pcdOnly` e a descrição.
- A busca do servidor é ampla (retorna vagas de design, comercial e enfermagem): a triagem de TI e a elegibilidade são nossas.
- Faixa `0` a `X` em `salary` significa limite inferior não informado: não pode ser lida como "bolsa mínima 0".
- Candidatura: vagas externas levam ao site da empresa; internas exigem a sua conta Sólides. Nos dois casos o fluxo é **assistido**.

## Decisão vigente (24/10/2026)

- Greenhouse, Lever e Ashby: preservar os adaptadores de descoberta existentes, somente leitura.
- LinkedIn, Indeed, Catho e InfoJobs: nenhuma automação de acesso ou candidatura. Links e textos fornecidos pelo usuário
  podem virar pistas e material de análise local; não devem disparar navegação nessas plataformas.
- Sólides: **não consultar o endpoint de vagas, não ativar coleta recorrente e não automatizar candidatura** enquanto a
  permissão aplicável não estiver esclarecida. `robots.txt`, HTTP 200 e ausência de proibição localizada não autorizam uso.
- O executor bloqueia esses domínios antes da navegação; sua sessão também bloqueia redirects, iframes e subrecursos para
  eles. O nome `artefactlinkedin` no caminho do Greenhouse não é acesso ao domínio LinkedIn.
- Nenhum envio real, concessão permanente, timer novo ou push foi autorizado nesta etapa.

## Sólides: fontes oficiais consultadas nesta etapa

1. [Cadastro do candidato](https://auth.vagas.solides.com.br/sign-up): há um link de termos/privacidade; a leitura pública
   disponível devolveu o próprio cadastro, sem revelar um documento de termos separado. Nenhuma conta foi criada.
2. [Política de privacidade](https://solides.com.br/politica-de-privacidade/): abrange candidatos; trata dados e propriedade
   intelectual. Não foi localizada nela permissão para nossa coleta de vagas.
3. [Termos da loja](https://loja.solides.com.br/termos-de-uso-e-responsabilidade/): contrato de software com o CLIENTE,
   incluindo Gestão/Profiler. A aplicabilidade ao uso independente do portal pelo AutoEstágio não ficou demonstrada.
4. [Configurações do Gestão](https://ajuda.solides.com.br/hc/pt-br/articles/4412075867021-Configura%C3%A7%C3%B5es-configura%C3%A7%C3%B5es):
   menciona API de integração no contexto da empresa cliente. Isso não comprova acesso público ao catálogo de vagas.
5. [Contato institucional](https://solides.com.br/contato/) e [solicitação de suporte](https://ajuda.solides.com.br/hc/pt-br/requests/new):
   canais oficiais encontrados para pedir encaminhamento à equipe responsável por integrações/termos do Portal de Vagas.

Conclusão operacional: **autorização pendente**. A pesquisa foi documental; nenhuma nova requisição automatizada ao
catálogo de vagas foi realizada. Não foi enviado contato à Sólides.

## Protótipo local e critério de ativação

`src/sources/solides-offline.ts` recebe somente um objeto em memória e retorna `RawJob[]`, descartes e um indicador de
paginação informativo. Os testes usam dados integralmente sintéticos. O contrato é **provisório**, não uma representação
validada da API real: os formatos de empresa, endereço, modalidade e salário precisam de amostras autorizadas antes da
integração. Sem cliente HTTP, sem paginação em rede, sem registro no scan, sem alteração em `config/sources.json`.

Já cobre salário com mínimo não informado, modalidade desconhecida/conflitante, descarte de registros inválidos e vagas
fora de estágio, e preservação textual de restrições afirmativas/PCD. Não decide elegibilidade nem envia candidaturas.

Para liberar coleta futuramente: obter os termos aplicáveis ou resposta escrita que cubra finalidade, endpoint oficial,
autenticação, armazenamento, limites e frequência; registrar escopo e validade; só então implementar o transporte e revisar
a ativação com o usuário. Não basta aceitar risco residual.

## Texto preparado para solicitar esclarecimento (não enviado)

Assunto: Uso pessoal de integração para consultar vagas públicas no Portal Sólides

Olá, equipe Sólides. Desenvolvo o AutoEstágio, ferramenta local para organizar minha busca pessoal por estágio em TI.
Gostaria de saber se existe API oficial ou autorização para consultar vagas públicas, sem login, apenas para leitura,
filtragem e armazenamento local dos anúncios. Não faremos candidaturas automáticas, acesso a dados de outros candidatos,
resolução de testes ou contorno de proteções.

Podem indicar os termos aplicáveis e a equipe responsável por autorizar esse uso? Precisamos confirmar os endpoints
permitidos, eventual credencial, frequência e volume máximos, prazo de armazenamento, atribuição e validade da permissão.
A coleta permanece desativada até esse esclarecimento. Obrigado.
