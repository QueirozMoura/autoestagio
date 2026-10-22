# Modelo mestre do currículo (Etapa 4.1)

Estrutura o currículo original em um modelo verificável, para que as próximas etapas personalizem sem
inventar. **A extração não aprova coisa alguma**: todo bloco nasce `rascunho`, nenhum link nasce confirmado e o
modelo não tem `approval`. Só você aprova, registrando a data (veja "Textos revisados e curadoria"). O arquivo real do modelo contém dados pessoais: `config/cv-master.json` (0600),
fora do Git. O PDF original nunca é modificado.

## Comandos

```
npm run dev -- cv extract [--pdf <caminho>] [--force]   # PDF mestre → config/cv-master.json (0600)
npm run dev -- cv report [--links] [--json] [--no-save]  # fidelidade, afirmações, links, propostas
npm run dev -- cv status                                 # o que ainda está pendente
```

- `extract` lê o PDF só para leitura (SHA-256 conferido), monta o modelo, detecta as afirmações a confirmar e
  gera as propostas. Se o modelo já existe, recusa sem `--force` (e com `--force` guarda o anterior como `.bak`).
- `report --links` consulta a internet **só para leitura**: poucas requisições, ritmo limitado, `robots.txt`
  respeitado. O relatório completo vai para `data/cv-reports/` (0600, fora do Git).

## Estrutura do modelo

`src/cv/schema.ts` (Zod), adaptado do spike 4.0. Resumo:

| Seção                                                | Conteúdo                                                                                   |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `master`                                             | SHA-256 do PDF mestre, nome do arquivo (sem caminho), páginas, data e extrator.            |
| `identity`                                           | nome, objetivo (`headline`), local, contatos, links do cabeçalho.                          |
| `summary`                                            | resumo profissional (bloco com variantes; no mestre, só a variante original).              |
| `experience` / `projects`                            | título exato, organização/cargo (subtrechos exatos), período, bullets, tecnologias, links. |
| `skills`, `education`, `languages`, `certifications` | linhas do PDF com os campos derivados.                                                     |
| `sectionTitles`                                      | títulos de seção que você aprovou (opcional).                                              |
| `claims`                                             | afirmações a confirmar (nascem `pendente`; ao resolver, ganham `resolution`).              |
| `proposals`                                          | variantes de resumo e destaques **propostos** (`status: "proposta"`), fora do currículo.   |
| `approval`                                           | **ausente** até você aprovar o modelo (exige ao menos uma variante aprovada por bloco).    |

Regras impostas pelo esquema:

- Todo texto do PDF tem `origin: "mestre"` e `sourceRef` (seção, página, linhas e SHA-256 do texto).
- `status: "aprovado"` ⇔ `approvedAt` presente. A extração nunca preenche nenhum dos dois.
- Links: `confirmedByUser` começa `false`. Estar no PDF não aprova o link.
- Ids únicos em todo o modelo (a seleção, os validadores e o histórico referenciam blocos por id).
- Preparado para o inglês no futuro, sem implementá-lo: o modelo é `pt-BR` hoje.

## Textos revisados e curadoria

Depois da extração, os textos que você revisou entram **sem tocar nos do PDF**:

- **Variantes `editada`** (resumo, bullets, variantes por área): `derivedFrom` aponta a variante do mestre de
  onde saíram e `basis` (obrigatório) diz por quê. O texto do mestre continua intacto ao lado.
- **`curated`** em entradas (título, tecnologias), skills e certificações (com `withheld` para o que ainda
  não foi conferido), e `sectionTitles`. O valor do PDF fica nos campos originais.
- **`basis`** separa a origem: `declaracao_proprietario` (o que você declarou; **não** é evidência),
  `decisao_proprietario`, `evidencia_codigo`, `evidencia_execucao` e `evidencia_publica`.
- **`claims[].resolution`**: afirmação `confirmada` ou `rejeitada` exige `resolution` (data, nota, bases).
  O `cv report` respeita o que já foi resolvido e só lista as pendentes.
- Declarações detalhadas ficam em `data/cv-declarations.json` (local, 0600, fora do Git).

A fidelidade com o PDF mede só as variantes `mestre`; as `editada` não entram nela.

## Seleção de variantes (`src/cv/selection.ts`)

Só vale variante `aprovado` com data; rascunho e `rejeitado` nunca são escolhidas.

- **Sem área:** só a variante genérica (sem área). Variante de área nunca atende um pedido sem área.
- **Com área, em bloco diferenciado por área (o resumo):** só a variante daquela área. A genérica **não**
  substitui uma específica ausente, em rascunho ou rejeitada (por isso Suporte e Dados seguem bloqueados).
- **Com área, em bloco sem variantes por área (cabeçalho, bullets):** a genérica.
- Bloco obrigatório sem variante utilizável faz `selectForResume` falhar (`MissingApprovedVariantError`).
- Aprovar variantes não aprova o modelo: `isModelFullyApproved` exige `approval` válido para o conteúdo
  atual e ao menos uma variante aprovada em cada bloco.

## Relatório de fidelidade

Compara o modelo com o PDF por métodos independentes da leitura estrutural:

- cada texto do modelo existe no PDF e **na ordem**;
- **palavras** (omissões e invenções), **números** e **links** (URL e rótulo) idênticos às anotações;
- campos derivados (organização/cargo, itens de skills, partes da formação) são subtrechos exatos;
- SHA-256 do mestre confere;
- segundo extrator opcional (Poppler, se instalado). Ele junta palavras com hífen quebrado
  ("e-" + "commerce" → "ecommerce"); isso é registrado como divergência **explicada**, não como falha.

## Afirmações que exigem confirmação

Detectadas por padrões de texto (apontam onde olhar; não julgam se é verdade): números de usuários e de testes,
produção/vendas, técnicas específicas, frases no presente, certificação, previsão de formação, links
(inclusive os terminados em hífen) e a estrutura "projeto sob Experiência profissional". Também faz
**verificações aritméticas** ("mais de 700" cujas partes somam exatamente 700; soma dos usuários × resumo).

## Propostas (não aprovadas)

Variantes de resumo por área e destaques por projeto, montados **só por seleção e junção de trechos do próprio
currículo**: cada trecho é cópia exata (a 1ª letra pode virar maiúscula), vem com a origem (`composedFrom`) e
nenhuma palavra nova entra (verificado). Áreas sem evidência real (ex.: suporte, dados) **não recebem proposta**,
com o motivo explicado. Versões "sem-numeros" evitam números não confirmados; as "com-numeros" são marcadas.
Os léxicos de área são genéricos (não contêm dados pessoais). Editar uma proposta à mão cria uma nova variante,
que também precisa de aprovação.

## Conferência de links

Evidências, nunca aprovação nem correção: a página responde? o repositório existe com o **nome exato**
(a API do GitHub devolve o nome canônico, com hífens)? a versão sem o hífen final existe? a homepage do
repositório aponta para a demo? o perfil do GitHub ou o portfólio declaram o mesmo LinkedIn? o README cita os
termos técnicos/números do currículo (indício, não prova)? Sites que proíbem leitura automatizada
(`robots.txt`, como o LinkedIn) **não são acessados**: o resultado é "inconclusivo" e a conferência é manual.

## Limitações

- O leitor é específico do formato deste currículo (títulos em negrito, `•`, "Tecnologias: … | Links: …").
  Estrutura desconhecida **falha com mensagem** em vez de descartar texto.
- O rótulo de cada link vem de posição no PDF; rótulos divergentes viram aviso.
- A API do GitHub sem autenticação tem limite (60/h); basta para esta conferência.
- Ausência de um termo no README não prova que não existe no código.
