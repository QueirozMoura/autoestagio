# Preparação de candidaturas (Etapa 3.3)

Prepara candidaturas **personalizadas e verdadeiras**, sempre em **dry-run**. Nada é enviado: não há
e-mail, navegador nem envio automático nesta etapa.

## Fluxo

```
npm run dev -- analyze                          # análise de elegibilidade (já existente)
npm run dev -- applications candidates          # vagas aptas/em revisão sem candidatura
npm run dev -- applications prepare <vaga> --channel manual
npm run dev -- applications preview <id>        # revisar no terminal
npm run dev -- applications answer <id> <chave> --text "..."   # você resolve pendências
npm run dev -- applications confirm-review <id> # você confirma a revisão (NÃO aprova o envio)
```

| Comando                                                                                                                                         | O que faz                                                                                                               |
| ----------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `applications candidates`                                                                                                                       | Lista vagas com análise atual (aptas e em revisão) ainda sem candidatura.                                               |
| `applications prepare <vaga> [--channel email\|portal\|manual] [--override-review "motivo"] [--acknowledge-equivalent "motivo"] [--regenerate]` | Reavalia a vaga com o perfil de agora, cria a candidatura (dry-run) e o rascunho, e levanta as pendências. Idempotente. |
| `applications preview <id>` (alias `review`) `[--show-answers] [--json]`                                                                        | Mostra assunto, mensagem, origem de cada afirmação e pendências.                                                        |
| `applications add-question <id> "<pergunta>"`                                                                                                   | Registra uma pergunta vista num formulário. Só o perfil aprovado responde o que sabe; o resto fica **pendente**.        |
| `applications answer <id> <chave> --text "..."`                                                                                                 | Você responde uma pendência.                                                                                            |
| `applications confirm-review <id>`                                                                                                              | Marca que você revisou **este** conteúdo. Qualquer mudança depois invalida a revisão.                                   |

## Regras

- **Só dados verdadeiros:** a mensagem usa apenas o perfil aprovado (conferido pelo SHA-256 do PDF)
  e o que a vaga publicou. Modelos de texto fixos, sem IA generativa: não há como inventar.
  Cada afirmação sai com a origem (`perfil.*` ou `vaga.*`).
- **Tecnologias:** só as que a vaga cita **e** o perfil tem. Inglês só aparece se a vaga o menciona,
  com o escopo exato do perfil (ex.: "apenas leitura técnica e documentação").
- **Quem pode ser preparada:** apta → sim. Em revisão humana → só com `--override-review "motivo"`
  para aquela vaga. Inapta → nunca.
- **Currículo:** o PDF nunca é aberto para escrita; a candidatura guarda o SHA-256 e o nome do arquivo.
- **Pendências (bloqueantes):** canal não definido; destinatário verificado (e-mail); perguntas do
  portal; pedidos da vaga que o perfil não cobre (pretensão salarial, links, histórico escolar,
  documentos pessoais); indeterminações de elegibilidade nas vagas em revisão. Nenhuma é preenchida
  automaticamente.
- **Perguntas de formulário:** o perfil responde só uma lista fechada de formas simples (nome, cidade,
  curso, instituição, semestre, previsão de conclusão, disponibilidade, inglês). Sensíveis (CPF,
  salário, gênero, nascimento...) e qualquer outra ficam pendentes.
- **Texto da vaga é não confiável:** links, e-mails, telefones, marcação e instruções embutidas são
  removidos/ignorados; uma barreira final recusa mensagem com e-mail, link, telefone ou tecnologia fora do perfil.
- **Situações do preparo:** `incompleta` → `pronta para revisão` → `revisada`; `desatualizada` quando
  a vaga, o perfil ou o gerador mudaram (`prepare --regenerate` refaz e zera a revisão).
- **Auditoria:** criação, geração, regeneração, respostas e revisão entram em `application_events`
  (sem o texto das respostas). Prévia oculta respostas, SHA-256 completo, hash do perfil e caminhos.

## Destaques de projetos (opcional)

`highlights` no perfil (título + resumo + tecnologias, todas presentes em `technologies`) permite citar
projetos, **com o texto exato que você aprovou**. Sem `highlights`, a mensagem não cita projetos.

## Limitações

- A mensagem é um modelo fixo em português; o tom é neutro e profissional, sem adaptação de estilo por empresa.
- Se o currículo mudar depois que a candidatura foi criada, o preparo é recusado (`curriculo_alterado`):
  a versão do currículo de uma candidatura não muda.
- Destinatário de e-mail e leitura de formulários chegam na Etapa 3.4.
