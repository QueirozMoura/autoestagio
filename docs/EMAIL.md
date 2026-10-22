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
