# Canal de e-mail (Gmail) — Etapa 3.4

**Estado atual: nada foi enviado.** O canal existe, está testado com um Gmail simulado e vem
**desligado** (`EMAIL_SEND_ENABLED=false`). O padrão é o ensaio (dry-run). Nenhum e-mail real sai
sem: trava mestra ligada + login OAuth + candidatura aprovada + destinatário verificado + currículo
conferido + **autorização específica de uso único** para aquela candidatura.

## Arquitetura

```
 preparo (3.3)            verificação                   envio
 ─────────────      ─────────────────────      ──────────────────────────
 rascunho revisado  → destinatário verificado → ensaio (dry-run, padrão)
 (SHA do currículo)   (vaga oficial ou          ↓
                       página oficial)       approve (modo revisao)
                                                ↓
                                           authorize (1 uso, 30 min,
                                            amarrada a conteúdo+PDF+destino)
                                                ↓
                                           send → RESERVA → Gmail → resultado
```

| Peça          | Arquivo                             | Papel                                                                                                              |
| ------------- | ----------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| OAuth 2.0     | `src/email/oauth.ts`                | App de computador: loopback `127.0.0.1` + PKCE (S256) + `state`. Escopo único `gmail.send`. Token em arquivo 0600. |
| Transporte    | `src/email/gmail.ts`                | `POST users.messages.send`, **sem retentativa**, classifica o resultado: aceito / recusado / desconhecido.         |
| MIME          | `src/email/mime.ts`                 | Texto UTF-8 + PDF; recusa quebra de linha em cabeçalhos; sem Cc/Bcc/From.                                          |
| Destinatários | `src/email/recipients.ts`           | Só endereço **escrito** na vaga oficial ou em página HTTPS do domínio da empresa. Nunca deduzido.                  |
| Orquestração  | `src/email/send.ts`                 | Verificações, autorização, reserva, envio, registro, recuperação.                                                  |
| Estado        | `src/applications/*`                | Reaproveita a máquina de estados e o histórico imutável da 3.2.                                                    |
| Banco         | `migrations/0007_email_channel.sql` | `verified_recipients`, `email_authorizations`, `email_dispatches`, `application_confirmations`.                    |

### O que o banco garante (além do código)

- No máximo **um** envio real em andamento/aceito/desconhecido por candidatura (índice único parcial): reenvio é impossível.
- Autorização de uso único (trigger) e confirmações imutáveis (triggers).
- Em dry-run nada pode estar "enviando/enviada" (trigger da 3.2).

### Ciclo do envio real

1. Verificações (inclui **ler o PDF agora** e conferir o SHA-256 contra a aprovação e a candidatura).
2. **Reserva** atômica: consome a autorização, grava o envio como `reservado` e a candidatura como `enviando`.
3. Chamada ao Gmail (os mesmos bytes do PDF lidos no passo 1 vão em anexo).
4. Resultado:
   - **aceito** (HTTP 200 com id) → `enviada`, id da mensagem registrado. **Só significa que o Gmail aceitou.**
   - **recusado** antes de enviar (somente HTTP 400, 401, 403 ou 413, ou falha de login antes da chamada) → `falhou`; nada saiu.
   - **desconhecido** (qualquer outro código — inclusive 404, 408, 422, 429 e 5xx —, 2xx sem id, timeout, rede, resposta ilegível, queda do processo) → `pendente_intervencao_humana`. **Nunca é reenviado sozinho.**

**Classificação dos erros HTTP (revisada):** só 400, 401, 403 e 413 são tratados como recusa, porque o Gmail
rejeita o pedido antes de processar a mensagem. 404, 408, 422 e 429 e todo 5xx foram para "desconhecido":
sem garantia de que não saiu, a candidatura vai para conferência humana. Um teste varre todos os códigos de 200 a 599.
Em nenhum caso existe reenvio automático: o transporte faz uma única requisição e a máquina de estados só deixa
uma pessoa reabrir o preparo.

### Três confirmações diferentes

Com o escopo mínimo (`gmail.send`) o projeto **não lê** a sua caixa. Por isso:

| Confirmação                  | Como é obtida                                                                                         |
| ---------------------------- | ----------------------------------------------------------------------------------------------------- |
| **Aceito pelo Gmail**        | Automática (id da mensagem devolvido pela API). Estado `enviada`.                                     |
| **Entrega confirmada**       | Você informa, com evidência (`email confirm --kind entrega`). Estado `entrega_confirmada`.            |
| **Recebimento pela empresa** | Você informa (ex.: resposta do RH) (`email confirm --kind recebimento`). Registro; não muda o estado. |

Ler devoluções automaticamente exigiria um escopo de leitura (restrito pelo Google). Não foi pedido.

## Permissões (escopos)

| Escopo                                                               | Uso                                                                           | Classificação do Google |
| -------------------------------------------------------------------- | ----------------------------------------------------------------------------- | ----------------------- |
| `https://www.googleapis.com/auth/gmail.send`                         | **O único pedido.** Enviar e-mails em seu nome.                               | Sensível                |
| `gmail.readonly`, `gmail.modify`, `gmail.compose`, `mail.google.com` | **Não são usados.** Um token com escopo diferente de `gmail.send` é recusado. | Restritos               |

Fontes: <https://developers.google.com/workspace/gmail/api/auth/scopes>,
<https://developers.google.com/workspace/gmail/api/guides/sending>,
<https://developers.google.com/identity/protocols/oauth2/native-app>.

## Configuração (uma vez)

1. No [Google Cloud Console](https://console.cloud.google.com/): crie um projeto e ative a **Gmail API**.
2. Tela de consentimento OAuth: tipo **Externo**, adicione **você** como usuário de teste e o escopo `gmail.send`.
   Observação: apps em modo de teste com escopos sensíveis podem ter o refresh token expirado depois de alguns dias
   (confirme na documentação do Google); se isso ocorrer, rode `email auth login` de novo.
3. Credenciais → **ID do cliente OAuth** → tipo **App para computador** → baixe o JSON.
4. Salve como `config/google-oauth-client.json` e restrinja: `chmod 600 config/google-oauth-client.json`
   (o arquivo está no `.gitignore`).
5. Sua caixa de teste: `config/email.json` → `{"testMailbox": "voce@exemplo.com"}` (também fora do Git).
6. Login (abre uma URL; o retorno chega em `127.0.0.1`):
   ```
   npm run dev -- email auth login
   npm run dev -- email auth status      # mostra se há login; nunca exibe tokens
   ```
   O token fica em `data/gmail-token.json` (0600, pasta 0700, fora do Git). Arquivo com permissão mais aberta é recusado.
7. **Não ligue ainda** `EMAIL_SEND_ENABLED`. Ele só deve ir a `true` (em `.env`) no momento de um envio autorizado.

## Comandos

| Comando                                                              | O que faz                                                                                                             |
| -------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `email auth login` / `status` / `logout [--local-only]`              | Login OAuth, estado (sem tokens), revogação + apagar token.                                                           |
| `email recipient scan <id>`                                          | Lista (mascarados) os e-mails escritos na vaga oficial.                                                               |
| `email recipient add <id> --email E --from-job [--confirm-freemail]` | Verifica um endereço que **está** na descrição da vaga. Provedor gratuito exige confirmação explícita.                |
| `email recipient add <id> --email E --page URL --company-domain D`   | Verifica um endereço presente numa página HTTPS do domínio oficial da empresa (lida com robots.txt e ritmo limitado). |
| `email recipient list <id>`                                          | Destinatários verificados (mascarados) e a fonte.                                                                     |
| `email dry-run <id> [--test]`                                        | **Ensaio (padrão).** Verificações + mensagem montada. Nunca chama o Gmail.                                            |
| `email approve <id> --reason "..."`                                  | Aprova a candidatura para envio real (modo `revisao`). Não envia.                                                     |
| `email authorize <id> --reason "..." [--test]`                       | Autoriza **um** envio (uso único, 30 min). Amarrada ao conteúdo, ao PDF e ao destinatário.                            |
| `email send <id> --authorization N [--test]`                         | Envia. Exige `EMAIL_SEND_ENABLED=true`.                                                                               |
| `email status <id>` / `email history <id>`                           | Envios, confirmações e histórico (sem endereços completos nem conteúdo).                                              |
| `email confirm <id> --kind entrega\|recebimento --evidence "..."`    | Registra as confirmações que só você pode dar.                                                                        |
| `email resolve <id> --sent\|--not-sent --evidence "..."`             | Resolve um envio de resultado desconhecido depois de conferir **Enviados**.                                           |
| `email recover`                                                      | Marca como desconhecidos os envios reservados que ficaram sem resultado.                                              |
| `backup`                                                             | Backup verificado do banco (também automático antes de migrar).                                                       |

## Fluxo em dry-run (o que roda hoje)

```
analyze → applications prepare <vaga> --channel email → applications preview <id>
→ email recipient scan <id> → email recipient add <id> --email … --from-job
→ applications confirm-review <id> → email dry-run <id>
```

O dry-run lista cada verificação (`[ok]`/`[FALHA]`/`[AVISO]`), monta o MIME real e mostra
destinatário mascarado, assunto, anexo e tamanho. Não faz nenhuma chamada ao Gmail.

## Procedimento para UM envio de teste (só depois da sua autorização)

O envio de teste vai **só para a sua caixa**, com assunto `[TESTE AutoEstagio]` e aviso no corpo.
Não altera o estado da candidatura nem marca nada como enviado à empresa.

1. `email auth login` (se ainda não fez) e confirme `email auth status`.
2. Escolha uma candidatura já preparada: `email dry-run <id> --test` deve terminar sem `[FALHA]`.
3. Ligue a trava só agora: em `.env`, `EMAIL_SEND_ENABLED=true`.
4. `email authorize <id> --test --reason "autorizo 1 envio de teste da candidatura #<id>"`
5. `email send <id> --test --authorization <n>`
6. Confira o e-mail na sua caixa e o PDF anexo (compare o SHA-256: `sha256sum` do arquivo baixado = o do perfil).
7. **Desligue de novo**: `EMAIL_SEND_ENABLED=false`.

Um envio real a uma empresa segue o mesmo caminho, sem `--test`, e **só com autorização sua para aquela
candidatura**: `approve` → `authorize` → `send`.

## Procedimentos de emergência

| Situação                       | O que fazer                                                                                                                                                                                             |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Parar tudo agora               | `EMAIL_SEND_ENABLED=false` em `.env` (ou apagar a variável). Nenhum envio é possível.                                                                                                                   |
| Suspeita de vazamento do token | `email auth logout`; depois revogue em <https://myaccount.google.com/permissions>; apague `data/gmail-token.json`; gere novo cliente OAuth no Cloud Console e troque `config/google-oauth-client.json`. |
| `RESULTADO DESCONHECIDO`       | **Não reenvie.** Abra **Enviados** no Gmail e procure pela empresa/assunto/data. Saiu → `email resolve <id> --sent --evidence "..."`. Não saiu → `email resolve <id> --not-sent --evidence "..."`.      |
| Processo caiu durante um envio | `email recover` (marca como desconhecido) e então `email resolve` como acima. Nunca há reenvio automático.                                                                                              |
| Enviei por engano              | Não há como "desenviar". Registre no histórico (`applications`), avise a empresa por você mesmo e mantenha `EMAIL_SEND_ENABLED=false`.                                                                  |
| Banco com problema             | Restaure um backup de `data/backups/` (0600, verificados por `integrity_check` e contagem de linhas): `cp data/backups/<arquivo>.db data/autoestagio.db` com o programa parado.                         |
| Token com permissão aberta     | O programa recusa usá-lo. `chmod 600 data/gmail-token.json` ou refaça o login.                                                                                                                          |

## Currículo: nova versão sem alterar nada em silêncio

- A candidatura guarda o SHA-256 do PDF e **ele não muda** (trigger). Antes de enviar, o PDF é lido de novo e
  o hash precisa ser igual ao da aprovação **e** ao da candidatura. Se o arquivo mudar, **o envio é bloqueado**
  (`curriculo_confere`).
- Para usar uma versão nova em candidaturas **futuras**:
  1. Guarde o PDF antigo com outro nome (ex.: `Curriculo_..._v1.pdf`); não o sobrescreva.
  2. Salve o novo PDF, calcule `sha256sum` e confira o conteúdo.
  3. Atualize `approval` em `config/profile.json` (novo `cvFile`, `cvSha256` e `approvedAt`) **somente depois de revisar o perfil**.
  4. `analyze` (o hash do perfil muda e a elegibilidade é refeita) e prepare as novas candidaturas.
- Candidaturas **já criadas e não enviadas** continuam presas à versão antiga e ficam **bloqueadas** (nada é trocado
  em silêncio). Refazê-las exigiria uma operação explícita de substituição, ainda não implementada (veja pendências).
- Candidaturas **já enviadas** nunca são alteradas: o histórico mantém o SHA-256 usado.

## Pendências de segurança conhecidas

1. Candidatura bloqueada por troca de currículo não pode ser refeita (UNIQUE por vaga). Falta um fluxo de "substituição" explícito.
2. Sem escopo de leitura, entrega e recebimento são manuais. Detecção de devolução (bounce) exigiria `gmail.readonly` (restrito).
3. O Gmail pode reescrever o `Message-ID`; a busca em **Enviados** deve usar destinatário, assunto e data (o cabeçalho
   `X-AutoEstagio-Dispatch` é gravado, mas não verificado em produção).
4. `client_secret` de app de computador não é confidencial para o Google, mas permanece fora do Git por higiene.
5. A verificação de "página oficial" depende do domínio que **você** informa; o programa confere que a página e o
   endereço pertencem a ele, mas não prova sozinho que o domínio é da empresa.
6. O envio só foi exercitado contra um Gmail simulado. Nenhum e-mail real foi enviado.

## Anexo personalizado e rascunho local `.eml` (Etapa 4.5c)

**Nada disto envia e-mail.** `EMAIL_SEND_ENABLED` continua `false` e o transporte do Gmail não foi alterado.

### Qual currículo é anexado

| Situação da candidatura                              | Anexo                                                                                        |
| ---------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Nunca teve vínculo de currículo (candidatura antiga) | Currículo mestre aprovado, como antes (nada é regenerado)                                    |
| Vínculo **aprovado** (`cv attachment approve`)       | PDF personalizado: é a fonte **obrigatória**; regenerado e validado em memória, com a âncora |
| Só histórico: em preparação, revogado ou substituído | **Bloqueio.** Nunca há fallback para o mestre; aprove um vínculo ou resolva explicitamente   |

Com vínculo aprovado, `email approve`, `dry-run`, `authorize`, `send` e `export-eml` precisam de
`--ancora-sha256 <hash>` (o SHA-256 do arquivo de âncora, informado por você). O PDF é regenerado pelo
fluxo estrito e só os bytes validados são usados; o arquivo em `data/cv-output/` não é lido. Se o hash do
PDF, a variante, o modelo editorial, a vaga ou o vínculo divergirem do registrado, o envio é bloqueado e nenhum
registro é atualizado. As verificações anteriores continuam (inclusive a do currículo mestre aprovado).

### Autorizações

O `bindingHash` da autorização passa a incluir o vínculo (id, variante, SHA-256 do PDF e hash do modelo)
quando há anexo personalizado. Para candidaturas sem vínculo o formato é exatamente o anterior. Criar,
aprovar, revogar ou substituir um vínculo vence na hora as autorizações **ainda não usadas** da candidatura
(gatilho do banco), e mesmo uma autorização reaberta à força não passa: o hash de vinculação deixa de conferir.

### Exportar um rascunho local

```
email export-eml <id> [--test] [--ancora-sha256 <hash>] [--output <diretório>]
```

Exige as mesmas verificações do envio (rascunho revisado, destinatário verificado, anexo correto e íntegro) e que
a candidatura esteja **aprovada para envio (`email approve`) — também com `--test`** —, exceto a trava mestra. Grava `candidatura-<id>-<real|teste>-<AAAAMMDD>-<sha8>.eml`
em `data/eml-drafts/` (padrão; 0700; arquivo 0600; nunca sobrescreve), com a mesma escrita privada de `cv generate`.
O MIME é validado antes de gravar (destinatário, corpo, anexo e fronteira). Não muda o estado da candidatura e só
registra um evento. O `dry-run` comum nunca cria `.eml`. O arquivo contém dados pessoais: mantenha-o privado.

## Envio controlado (Etapa 4.6)

Roteiro passo a passo em [`SEND_RUNBOOK.md`](SEND_RUNBOOK.md). Em resumo, o envio **real** passa a exigir, além de tudo o
que já existia:

- **Código de confirmação** (`email preview-final` → `email authorize --confirm <código>`): derivado do conteúdo, do anexo (com a
  identidade do vínculo) e do destinatário reais; muda se qualquer um mudar. Não substitui a autorização de uso único.
- **Envio de teste aceito** para exatamente esse conteúdo, anexo e destinatário real pretendido (evidência persistida em
  `email_dispatches.intended_binding_hash`, migração 0009), **com no máximo 24 h** (pelo horário persistido do despacho aceito;
  horário inválido ou futuro além de 2 min de tolerância invalida). Dry-run e `.eml` não contam; qualquer mudança a invalida.
- **Intervalo mínimo de 15 minutos** entre envios reais e **30 dias** sem repetir o mesmo destinatário (normalizado) em outra
  candidatura. Envios de resultado incerto contam (conservador). Não há bypass. Os envios de teste não são afetados.
- `apply status <candidatura>` mostra todas as etapas e a próxima ação (somente leitura).

Esses portões bloqueiam `authorize` e `send`; não impedem aprovar, ensaiar ou exportar o `.eml`. O texto do rascunho não cita mais
o nome do arquivo do currículo mestre ("Segue meu currículo em anexo.").

Os limites, o teste prévio, a autorização de uso único e a anti-duplicação são **reavaliados dentro da transação imediata da
reserva do envio** (SQLite `BEGIN IMMEDIATE`, que serializa os escritores), e não só no preflight: duas execuções simultâneas
para candidaturas diferentes não passam juntas por limites globais ou de destinatário. A transação termina antes da chamada ao
Gmail (nenhuma transação fica aberta durante a rede).
