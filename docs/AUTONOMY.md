# Modo autônomo

Pipeline que roda sem conversa aberta (inclusive por `systemd`): **coleta → análise → ranking → política →
(conector) → registro**. Por padrão é **simulação**: decide o que faria, grava a decisão e **não envia nada**.
O envio real exige política ligada, `real.authorized`, uma **concessão** vigente e `EMAIL_SEND_ENABLED=true`.

```bash
npm run dev -- autonomo run [--no-scan] [--real]   # simulação (padrão); --real só com concessão
npm run dev -- autonomo diagnose                   # por que as vagas não são aptas (dados ausentes x incompatível)
npm run dev -- autonomo grant [--days 30]          # resumo + código; com --confirm <código> --reason "..." grava
npm run dev -- autonomo revoke <id> --reason "..." # revoga a concessão (efeito imediato)
npm run dev -- autonomo status | history [--run <id>] | stop | resume
npm run dev -- autonomo timer [--write [dir]]      # unidades systemd (user) da SIMULAÇÃO; não habilita nada
```

## Política (`config/autonomy.json`, fora do Git; modelo em `config/autonomy.example.json`)

Sem o arquivo, o modo está **desligado**. Estrita: chave desconhecida é erro.

- `salaryExpectation` (R$ 1.800): pretensão dos formulários. **Não** é a bolsa oferecida.
- `rules`: fontes, empresas (permitidas/excluídas), áreas, modalidades, `minStipend` (só com bolsa divulgada),
  `verdicts` (`apto` por padrão) e `tolerateUnknown` (vazio; só aceita `bolsa`, e nunca cobre bolsa divulgada
  abaixo do mínimo).
- `limits`: 5 por execução, 10 por dia, pausa de 3 min (o canal de e-mail impõe o piso de 15 min; vale o maior).
- `real`: `authorized` e `connectors` (ex.: `["email"]`). A validade vem da concessão.

## Autorização permanente (concessão)

`autonomo grant` mostra o resumo e um **código** que depende da política e do prazo. Só com
`--confirm <código> --reason "..."` a concessão é gravada em `autonomous_grants`: prazo (até 90 dias), conectores,
limites e hash da política **congelados**. Mudou a política → a concessão deixa de valer. `autonomo revoke` encerra.
Nada disso liga o envio sozinho: `enabled`, `real.authorized` e a trava `EMAIL_SEND_ENABLED` continuam necessárias.

## Conector de e-mail

Percorre os **mesmos portões** do envio manual, em nome da concessão (citada na trilha de auditoria):
destinatário único e corporativo escrito na descrição da vaga (nunca deduzido; provedor gratuito, vários
endereços ou nenhum → pendente) → preparo → rascunho sem pergunta sem resposta → aprovação → **teste prévio**
para a sua caixa → código de confirmação → autorização de uso único → reserva antes do Gmail → envio.
Resultado incerto vira `envio_incerto` e **nunca** é reenviado. Equivalência de vagas (mesma URL, empresa+título+local)
bloqueia e fica pendente: o modo autônomo não aplica liberações humanas. Cada envio grava evidência
(`candidatura:<id>;envio:<id>`) em `autonomous_decisions` e é registrado em `applications`/`email_dispatches`.

Portais (`inhire`, `gupy`, `greenhouse`, `lever`, `ashby`) ficam **indisponíveis**: reCAPTCHA, login ou chave da empresa.

## Decisões e relatório

`candidatar` (simulação) · `enviada` · `envio_incerto` · `pendente_canal` · `pendente` · `descartada` ·
`limite_atingido`. O relatório mostra enviadas com evidência, incertas, pendências com o motivo, motivos de
descarte agrupados, limites, erros e a coleta. `autonomo history --run <id>` repete as decisões.

## Execução sem conversa (systemd)

`autonomo timer --write` grava `autoestagio-autonomo.service` e `.timer` (02:30, 09:30 e 15:30, com atraso
aleatório e `Persistent=true`). O serviço usa o `node` absoluto e `--import tsx` no diretório do projeto; o `.env`
e os caminhos são lidos do projeto. Para rodar sem sessão aberta: `loginctl enable-linger $USER`. Habilitar é
decisão sua (`systemctl --user enable --now autoestagio-autonomo.timer`); para o envio real a unidade precisa de
`--real` (gere com a opção `real` de `systemdUnits`) e de todas as autorizações acima.

## Segurança

Uma execução por vez (trava no SQLite), arquivo de parada (`autonomo stop`), candidatura única por vaga
(`UNIQUE` no banco), tentativa gravada **antes** de enviar (queda no meio vira `envio_incerto`), limites por
execução e por dia (inclui o do ambiente e o da concessão) e nenhuma burla de CAPTCHA, anti-bot ou avaliações.
