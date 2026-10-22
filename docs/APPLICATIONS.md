# Candidaturas: histórico e prevenção de duplicidade (Etapa 3.2)

Nada aqui envia e-mail, abre navegador ou candidata de verdade. A etapa registra o **estado** e o
**histórico** de candidaturas e garante que nenhuma vaga receba duas.

## Estados

`preparada → aprovada_para_envio → enviando → enviada → entrega_confirmada`, mais `falhou` e
`pendente_intervencao_humana`.

- `enviando` (além dos seis pedidos) marca "envio reservado, resultado ainda não registrado". Se o
  processo cair nesse ponto, a candidatura **nunca é reenviada sozinha**: `applications recover`
  a move para `pendente_intervencao_humana`, e só uma pessoa resolve.
- Depois de `enviada`, não volta a `preparada`. Depois de uma tentativa de envio, só uma pessoa refaz o preparo.
- `entrega_confirmada` exige a evidência da confirmação (guardada, nunca exibida na CLI).

## Modos

`dry-run` (padrão, nasce assim), `revisao` e `auto`. Em dry-run a candidatura não aprova nem envia
(código **e** trigger no banco). `auto` exige autorização explícita do usuário e só uma pessoa muda o modo.

## Criação e duplicidade

Só nasce de vaga **apta** (ou em revisão humana liberada por uma pessoa, com motivo), analisada com
o perfil atual. Vaga inapta nunca. Bloqueios:

| Situação                                                                  | Efeito                                                             |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| Mesma vaga (`job_id` UNIQUE no banco)                                     | devolve a existente (idempotente)                                  |
| Mesma URL canônica, de candidatura ou de outra aparição                   | bloqueia; ninguém libera                                           |
| Mesma identidade (empresa+título+local) ou "possível duplicata" da coleta | bloqueia; uma pessoa pode reconhecer que é outra vaga (com motivo) |
| Mesma empresa, outra vaga                                                 | só aviso                                                           |

Antes de reservar o envio a checagem roda de novo: se uma equivalente já saiu, o envio é bloqueado.
Candidaturas que falharam sem nunca terem saído não contam como duplicata.

## Auditoria

`application_events` é imutável (triggers). Cada evento: data, de/para, modo, canal, ator
(`sistema`/`usuario`), motivo e chave de idempotência opcional. A versão do currículo (SHA-256 +
nome do arquivo, sem caminho) fica na candidatura e não muda depois de criada.

## Concorrência e recuperação

Cada operação roda em transação `IMMEDIATE` (o SQLite serializa escritores entre processos) com
`busy_timeout`, atualização condicional pelo estado esperado e chave de idempotência. Testado com
vários processos sobre o mesmo arquivo.

## CLI (somente consulta)

`applications list [--status] | show <id> | history <id> | stats | recover [--older-than-min n]`
(`--json` onde cabe). Não mostram destinatários, textos, evidências, caminhos nem o hash do perfil;
o SHA-256 do currículo aparece só nos 12 primeiros caracteres.
