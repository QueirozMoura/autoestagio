# Spike 4.0 — geração de currículo em PDF: decisão técnica

Data: 2026-10-22. Escopo: comparar **PDFKit** (JavaScript), **HTML + WeasyPrint** (Python) e
**LibreOffice headless**, e propor o modelo de currículo. **Nada aqui é código de produto**: o spike
vive em `spikes/cv-renderers/`, com dados **fictícios** e dependências isoladas. As Etapas 4.1 a 4.6 não
foram implementadas, o currículo original não foi modificado (SHA-256 conferido antes e depois) e o
perfil aprovado não foi alterado.

## 1. Método

- **Mesmo documento, mesmo design, três renderizadores.** Um fixture fictício (3 experiências, 2 projetos,
  6 categorias de skills, 54 blocos de texto) validado pelo esquema proposto. A4, fonte Lato (OFL-1.1) embutida.
- **Quatro configurações** por renderizador (ligaduras ligadas/desligadas × datas à direita/na linha do título),
  cada uma gerada **duas vezes** (determinismo e tempo).
- **Cinco modos de extração de texto** (proxies do que um ATS faz): Poppler (ordem de leitura), Poppler `-layout`,
  Ghostscript `txtwrite`, pypdf e pdfminer.six.
- **Métricas:** blocos encontrados (fidelidade), ordem de leitura (busca sequencial), título e data adjacentes,
  contato e links íntegros, títulos de seção como linhas, caracteres estranhos, bullets, fontes embutidas com
  ToUnicode, estrutura (tags), metadados, tamanho, tempo, determinismo e páginas.
- **Estresse:** caracteres especiais (`C#`, `.NET`, `R$ 1.200,00`, `%`, aspas, travessões, `ç ã ñ`, `fi/fl/ff`, `< >`),
  variante por área (QA) e conteúdo longo demais (detecção de estouro de página).
- **Imagens** de cada PDF conferidas visualmente.

> **Limite honesto:** isto mede _proxies_. Não há como prometer aprovação em nenhum ATS real (Workday, Taleo,
> Greenhouse, Lever, Gupy etc. têm parsers próprios e não testados aqui). O que se pode afirmar é que o PDF
> segue as boas práticas conhecidas e se comporta bem em cinco extratores independentes.

## 2. Resultado

Configuração final de cada renderizador (ligaduras desligadas, data na linha do título, mesma fonte e tamanho na
linha, URLs visíveis):

| Critério                             | PDFKit                                                         | WeasyPrint                                                             | LibreOffice                                                       |
| ------------------------------------ | -------------------------------------------------------------- | ---------------------------------------------------------------------- | ----------------------------------------------------------------- |
| Qualidade visual (A4, 1 página)      | Ótima                                                          | Ótima                                                                  | Ótima (espaçamento um pouco mais apertado)                        |
| Fidelidade (54 blocos, 5 extratores) | 100%                                                           | 100%                                                                   | 100%                                                              |
| Ordem de leitura (5 extratores)      | 100%                                                           | 100%                                                                   | 100%                                                              |
| Conteúdo a mais/a menos vs. esperado | só os rótulos estáticos ("Links:", ":")                        | idem                                                                   | idem                                                              |
| Fontes                               | embutidas, subset, ToUnicode                                   | idem                                                                   | idem (TrueType WinAnsi)                                           |
| Tamanho do arquivo                   | 47,6 KB                                                        | 31,7 KB                                                                | 66,6 KB                                                           |
| Determinístico (mesmos bytes)        | **sim** (data fixa)                                            | **sim** (`SOURCE_DATE_EPOCH`)                                          | **não** (`/ID` aleatório)                                         |
| Tempo por PDF (a quente)             | ~185 ms                                                        | ~575 ms                                                                | ~335 ms                                                           |
| PDF "tagged"                         | sim, estrutura limpa (`Document, H1–H3, P, L, LI, Lbl, LBody`) | sim (PDF/UA-1), com ruído (`NonStruct, Span, Sect, Art`)               | sim, mas com papéis não padrão (`Headline, Contact, EntryTitle…`) |
| Anotações de link                    | 6/6 (após correção manual)                                     | 6/6                                                                    | 6/6                                                               |
| Dependências                         | 18 pacotes npm (26 MB), JS puro, MIT                           | Python 3.14 + 20 pacotes (115 MB) + bibliotecas nativas (Pango), BSD-3 | instalação de sistema (344 MB), MPL-2.0                           |
| Código do renderizador               | 187 linhas (imperativo)                                        | 89 linhas (HTML+CSS)                                                   | 92 linhas (XML)                                                   |
| Ajuste a 1 página                    | mede a altura antes/durante e já informa o estouro             | renderizar e contar páginas                                            | renderizar e contar páginas                                       |
| Integração com o resto do projeto    | nativa (Node, vitest, sem subprocesso)                         | subprocesso Python                                                     | subprocesso, perfil único, instância travada                      |

### Achados que valem mais do que a escolha do renderizador

Quatro armadilhas de ATS apareceram nos **três** renderizadores. Cada uma foi isolada e corrigida; viram regras
de layout e validadores futuros:

1. **Ligaduras.** O Ghostscript extrai "Offline" como **"Ofnine"** (ligadura `fl` do Lato). Desligar `liga/clig`
   corrige os três. Regra: **sem ligaduras**.
2. **Datas alinhadas à direita.** O pdfminer move o "2026" para o meio do parágrafo seguinte e o Poppler (modo
   bruto) perde a ordem (35–74% antes da correção). Regra: **data na mesma linha do título**, separada por `|`.
3. **Tamanhos diferentes na mesma linha.** O Ghostscript inverte a ordem dos trechos ("| 2026" antes do título).
   Regra: **mesma linha, mesmo tamanho de fonte** (negrito e regular podem alternar).
4. **Links só como anotação.** O seu currículo original tem **13 anotações de link e nenhuma URL no texto
   extraível**: um parser que lê só texto vê "LinkedIn | GitHub | Portfólio" sem destino. Regra: **URL visível**
   (ao menos nos links principais), além da anotação.

Outros pontos, comuns a todos: o Poppler junta palavras com hífen quebradas no fim da linha ("hífen-minus" →
"hífenminus"); o pypdf insere um espaço em URLs longas (`https:/ /`), então a URL visível ajuda mas não é garantia
para esse extrator.

Específico do **PDFKit**: `continued: true` com `link` perde anotações quando há mais de um link na linha (2 de 6
sumiram). Solução adotada: anotações manuais (`doc.link`) com medição de largura (~25 linhas de código).

## 3. Recomendação

**Adotar o PDFKit como renderizador principal da Etapa 4.3**, mantendo as regras de layout acima.

Por quê:

- **Atende à sua preferência por JavaScript sem perder nada medido:** mesma qualidade visual, 100% de fidelidade e
  de ordem de leitura nos cinco extratores, fontes embutidas, PDF tagged com estrutura limpa.
- **Determinismo nativo:** com data fixa o PDF sai byte a byte igual. Isso é o que torna o **SHA-256 por PDF**
  (requisito central do módulo) estável e testável, e permite verificar "o arquivo anexado é exatamente o aprovado".
- **Zero dependência externa de sistema:** só um pacote npm (JS puro). Encaixa no projeto (Node ≥ 22, vitest,
  sem subprocessos) e é o mais rápido (~185 ms), o que torna viável um laço de ajuste a 1 página.
- **A medição de layout é do próprio código**, o que ajuda no ajuste a 1 página e nos validadores (mapear cada linha
  do PDF a um bloco aprovado).

Custos aceitos: o layout é imperativo (mais código que HTML+CSS), é preciso implementar o ajuste a 1 página
(medir e omitir blocos de menor prioridade) e as anotações de link são manuais.

### Alternativas

- **WeasyPrint** é uma boa segunda opção e ficou empatado em qualidade e ATS; é a melhor ferramenta para iterar
  no _visual_ (CSS) e foi a que gerou o seu currículo atual. Fica como **plano B documentado** caso o layout
  imperativo vire um fardo (por exemplo, com muitos modelos visuais). Contra: exige Python e bibliotecas nativas
  (Pango) em toda máquina que gerar PDFs, é ~3× mais lento e a árvore de tags tem ruído.
- **LibreOffice: descartado.** Não é determinístico (o `/ID` do PDF muda a cada geração, o que quebraria a
  verificação de SHA-256 sem pós-processamento), pesa 344 MB, usa um perfil de usuário único (trava em execução
  concorrente) e produz papéis de estrutura não padrão. A qualidade visual é boa, mas não compensa.

### O que esta recomendação **não** afirma

- Que o PDF será aceito por todos os ATS. Só foi medido contra cinco extratores de texto.
- Que o fixture represente todos os currículos: ele é fictício e com um perfil de conteúdo parecido com o seu.
- Que o PDFKit seja melhor que o WeasyPrint em qualidade visual: ficaram equivalentes. A escolha é por
  determinismo, dependências e integração.

## 4. Regras de layout ATS adotadas (para a 4.3)

1. Uma coluna, sem tabelas, imagens, ícones nem caixas de texto.
2. Texto real e selecionável; fontes **embutidas** com ToUnicode (Lato, OFL-1.1: incluir a licença se o arquivo
   da fonte for versionado).
3. **Sem ligaduras.**
4. Títulos de seção padrão e em linha própria (`RESUMO PROFISSIONAL`, `EXPERIÊNCIA PROFISSIONAL`, `EDUCAÇÃO`…).
5. **Data na mesma linha do título**, com `|`; nada de alinhamento à direita nem tabulação.
6. **Mesmo tamanho de fonte dentro de uma linha.**
7. Bullets como o caractere `•` real no texto, com recuo.
8. **URLs visíveis** (rótulo + endereço) e anotação de link.
9. Contato (e-mail e telefone) numa linha, sem quebra no meio.
10. Metadados limpos e fixos (título, autor, produtor neutro; sem caminhos nem nome de usuário).
11. Data de criação fixa (determinismo) e tamanho pequeno (dezenas de KB).
12. 1 página A4 (limite configurável até 2).

## 5. Modelo de currículo (proposta; implementação na Etapa 4.1)

Arquivo de referência: `spikes/cv-renderers/model.schema.ts` (Zod), validado com o fixture fictício e com 12 casos
de rejeição (`tools/model-checks.ts`). O arquivo **real** do modelo guarda dados pessoais e ficará **fora do Git**,
como o perfil.

Princípios:

1. **Todo texto visível é um bloco** com `id` estável e texto **exato** aprovado. O PDF só escolhe e ordena.
2. **Variar o texto = escolher entre variantes pré-aprovadas** (`variants[]`, cada uma com `approvedAt`).
   Nada é gerado livremente.
3. **Cada bloco aponta para a origem no PDF mestre** (`sourceRef.section` + `excerptSha256`): sem origem, o bloco
   não pode ser aprovado.
4. **Localizável:** `{ "pt-BR": "...", "en"?: "..." }`. `pt-BR` é obrigatório; o inglês fica opcional. Um
   documento em inglês só é aceito se todas as variantes usadas tiverem a versão em inglês (já testado).
5. **Ids únicos em todo o modelo**, porque a seleção, os validadores e o histórico referenciam blocos por `id`.
6. **Links** com `confirmedByUser` (a URL veio do PDF mestre e foi conferida; nunca é adivinhada).
7. **Áreas** (`desenvolvimento`, `qa`, `suporte`, `infraestrutura`, `dados`, `banco-de-dados`) iguais às do motor
   de elegibilidade, para a seleção por vaga.

Estrutura (resumo):

```jsonc
{
  "schemaVersion": 1,
  "language": "pt-BR",
  "master": { "sha256": "<64 hex>", "label": "…", "extractedAt": "AAAA-MM-DD" },
  "identity": { "name": "…", "headline": <VariantBlock>, "location": "…", "contacts": [...], "links": [...] },
  "summary": <VariantBlock>,
  "experience": [ { "id", "kind", "title", "organization?", "period", "summary?", "bullets": [<VariantBlock>],
                    "technologies", "links", "priority", "sourceRef" } ],
  "projects": [ …mesmo formato… ],
  "education": [ { "id", "course", "institution", "degreeType?", "status", "statusLabel", "sourceRef" } ],
  "skills": [ { "id", "category", "items", "priority", "areas", "sourceRef" } ],
  "languages": [ { "id", "label", "sourceRef" } ],
  "certifications": [ { "id", "title", "issuer", "year", "sourceRef" } ],
  "layout": { "sectionOrder": [...], "maxPages": 1 }
}
// VariantBlock = { id, required, priority, variants: [ { id, text:{pt-BR,en?}, areas[], technologies[],
//                  sourceRef:{section, excerptSha256}, approvedAt } ] }
```

Decisões de modelagem que a 4.1 deve fechar com você: onde moram os **números de usuários** ("em média por 50
pessoas") e as **afirmações técnicas** (cada uma vira uma variante com `approvedAt` própria, aprovada por você
antes de entrar no modelo); como os **highlights** da mensagem passam a derivar dos mesmos blocos; e como
registrar a **aprovação do modelo** (hash do JSON canônico + SHA-256 do mestre).

## 6. Implicações para as próximas etapas

- **4.2 (seleção):** a seleção devolve ids de blocos/variantes e a ordem; é pura e determinística. O protótipo
  `view.ts` mostra a ideia com a variante padrão por área.
- **4.3 (renderização e validadores):** os validadores podem reaproveitar `tools/analyze.py`: texto extraído →
  cada linha precisa mapear a um bloco aprovado; conferir fontes, páginas, metadados, ligaduras, ordem e links.
  O ajuste a 1 página omite blocos por `priority` e reduz espaçamentos antes de falhar.
- **4.5 (Gmail):** com PDFs determinísticos, o SHA-256 do anexo é reprodutível a partir do modelo + seleção, e a
  verificação "o arquivo no disco é o aprovado" continua valendo como hoje.
- **Calibração com ATS reais (manual, opcional):** enviar uma variante a formulários de vaga que exibem os
  campos extraídos, ou a verificadores gratuitos de parsing, e conferir os campos. Isso só você pode fazer.

## 7. Como reproduzir

Veja `spikes/cv-renderers/README.md`. As saídas (`out/`) são regeneráveis e ficam fora do Git.
