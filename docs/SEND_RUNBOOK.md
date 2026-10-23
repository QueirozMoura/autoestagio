# Roteiro de envio controlado (Etapa 4.6)

Este roteiro leva UMA candidatura da vaga ao envio por e-mail. **Nada aqui é automático e nada é feito em massa.**
O envio real só acontece com: teste prévio aceito, código de confirmação, autorização de uso único, e a trava
`EMAIL_SEND_ENABLED=true` ligada **apenas na execução do envio**. Os comandos usam `npm run dev --` (ou `node dist/cli/index.js`).

> Este documento descreve o procedimento. Seguir os passos reais é uma decisão sua; o código não os executa.

## 0. Antes de tudo

1. `npm run dev -- migrate` (faz backup verificado antes de aplicar migrações pendentes, inclusive a 0009).
2. Em qualquer momento: `npm run dev -- apply status <candidatura>` (ou `--job <vaga>`) mostra cada etapa e a **próxima
   ação**. É somente leitura e mascara o destinatário.

## 1. Configurar o Gmail e a caixa de teste (uma vez)

1. Credenciais OAuth (tipo "App para computador"): veja `docs/EMAIL.md` ("Configuração"). Salve em
   `config/google-oauth-client.json` com `chmod 600`. O escopo é só `gmail.send`.
2. Caixa de teste (só sua): `config/email.json` → `{"testMailbox": "voce@exemplo.com"}`.
3. `npm run dev -- email auth login` e depois `email auth status` (nunca mostra tokens).
4. **Não** altere `EMAIL_SEND_ENABLED` no `.env`: ele permanece `false`.

## 2. Escolher e preparar a vaga

1. `npm run dev -- analyze` e `npm run dev -- applications candidates`.
2. Só vagas com **e-mail oficial** no texto (ou em página HTTPS do domínio da empresa) servem a este roteiro.
3. `npm run dev -- applications prepare <vaga> --channel email` (vaga em revisão humana exige
   `--override-review "<motivo>"`, uma decisão sua).

## 3. Revisar conteúdo e destinatário

1. `applications preview <candidatura>`: confira assunto, corpo e pendências; `applications answer`/`add-question` se preciso.
2. `email recipient scan <candidatura>` e `email recipient add <candidatura> --email <endereço> --from-job`
   (ou `--page <https://domínio> --company-domain <domínio>`). Nenhum endereço é adivinhado.
3. `applications confirm-review <candidatura>`.

## 4. Currículo (opcional, personalizado)

Sem vínculo, o anexo é o currículo mestre aprovado. Para um currículo por área (a variante é **sempre escolhida por você**):

1. `cv attach --application <candidatura> --variant <id> --ancora-sha256 <hash>`
2. `cv attachment list <candidatura>` (anote o `sha8`)
3. `cv attachment approve <candidatura> --sha8 <sha8> --reason "..." --ancora-sha256 <hash>`

Depois disso, todos os comandos de e-mail abaixo precisam de `--ancora-sha256 <hash>` para regenerar e validar o PDF.
Aprovar o currículo **não** autoriza envio. Se houver vínculo revogado/em preparação e nenhum aprovado, o envio é bloqueado
(não há fallback para o mestre).

## 5. Aprovar para envio e ensaiar

1. `email approve <candidatura> --reason "..." [--ancora-sha256 <hash>]`
2. `email dry-run <candidatura> [--ancora-sha256 <hash>]`: monta o MIME, nunca chama o Gmail.
3. Opcional: `email export-eml <candidatura> [--test]` grava um `.eml` local privado (exige o passo 1).

## 6. Teste controlado (obrigatório)

O envio real só é liberado se existir um teste **aceito**, feito há **no máximo 24 horas**, para exatamente este conteúdo, anexo e destinatário.
Dry-run e `.eml` **não** contam. O teste vai só para a sua caixa de teste.

1. `email authorize <candidatura> --test --reason "teste da candidatura" [--ancora-sha256 <hash>]`
2. `EMAIL_SEND_ENABLED=true npm run dev -- email send <candidatura> --authorization <n> --test [--ancora-sha256 <hash>]`
3. Abra a mensagem na sua caixa de teste e confira: assunto, corpo, anexo (abre e é o currículo certo).
4. `email status <candidatura>` mostra o resultado (sem endereços completos). Se o resultado for incerto, trate como no passo 9.

Qualquer mudança depois do teste (destinatário, texto, anexo, vínculo) ou mais de 24 horas invalidam a evidência: refaça o teste.

## 7. Autorizar o envio real

1. `email preview-final <candidatura> [--ancora-sha256 <hash>]`: mostra, só no terminal, o destinatário completo e a fonte
   oficial, o assunto, o corpo, o anexo (variante, páginas, tamanho, `sha8`), as verificações e um **código de 8 caracteres**.
2. Confira tudo. Se estiver certo:
   `email authorize <candidatura> --reason "autorizo enviar a candidatura #N para <empresa>" --confirm <código> [--ancora-sha256 <hash>]`

A autorização vale para **um** envio e 30 minutos, e fica amarrada ao conteúdo, ao anexo e ao destinatário. O código muda se
qualquer um deles mudar.

## 8. Enviar (somente na execução autorizada)

```
EMAIL_SEND_ENABLED=true npm run dev -- email send <candidatura> --authorization <n> [--ancora-sha256 <hash>]
```

- A variável vale só para esse comando; o `.env` continua com `false`.
- Limites: no máximo um envio real a cada 15 minutos; o mesmo destinatário (normalizado) não recebe de outra candidatura
  por 30 dias; `MAX_APPLICATIONS_PER_DAY` (sugestão: `1` nos primeiros envios). Não há como ignorar esses limites.
- "Aceito pelo Gmail" **não** confirma entrega. Registre a entrega só com evidência: `email confirm <candidatura> --kind entrega --evidence "..."`.

## 9. Resultado incerto (nunca reenviar)

Se a saída disser **RESULTADO DESCONHECIDO** (ou o processo caiu):

1. **Não rode `send` de novo.** O sistema também não o fará.
2. `email recover` (marca envios reservados sem resultado como incertos).
3. Abra a pasta **Enviados** do Gmail e procure a mensagem.
4. `email resolve <candidatura> --sent --evidence "..."` ou `--not-sent --evidence "..."`.
5. Só depois de `--not-sent` e de uma decisão sua é possível refazer o preparo.

## 10. Depois

`apply status <candidatura>` e `email history <candidatura>` registram o que aconteceu. `EMAIL_SEND_ENABLED` deve continuar
`false` no `.env`.
