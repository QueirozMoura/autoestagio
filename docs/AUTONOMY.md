# Modo autônomo

A preparação agendada e o relatório da madrugada estão descritos em [OVERNIGHT.md](OVERNIGHT.md).

Pipeline que roda sem conversa aberta (inclusive por `systemd`): **coleta → análise → ranking → política →
(conector) → registro**. Por padrão é **simulação**: decide o que faria, grava a decisão e **não envia nada**.
O envio real exige política ligada, `real.authorized`, uma **concessão** vigente e `EMAIL_SEND_ENABLED=true`.

```bash
npm run dev -- autonomo run [--no-scan] [--real]   # simulação (padrão); --real só com concessão
npm run dev -- autonomo sources [--days 7]        # métricas por fonte: novas, em TI, relevantes, automatizáveis
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

## Agente híbrido: dois fluxos e a fila

- **Automático:** o agente conclui sozinho, dentro da concessão, as vagas com canal compatível (hoje, e-mail de
  candidatura utilizável).
- **Assistido:** vagas em portais com login, CAPTCHA, avaliação ou decisão sua. O agente descobre, analisa, escolhe a
  variante do currículo, reúne os dados (pretensão R$ 1.800) e deixa a vaga **pronta**; a execução assistida acontece
  no **seu navegador**, sob a sua autorização, e para antes de qualquer etapa que dependa de você. Uma vaga assistida
  nunca bloqueia as demais.
- `autonomo queue build|list|set`: fila priorizada (ranking transparente; a área não pesa; automático antes de
  assistido), idempotente, uma linha por vaga. **Concluir exige evidência** (confirmação da plataforma ou e-mail) e
  é definitivo; cancelar exige motivo. `autonomo run` reconstrói a fila a cada execução.
- `tolerateUnknown` aceita `bolsa` e `modalidade`. Modalidade desconhecida **nunca** vira remoto nem híbrido; a fila
  traz o aviso e, se o formulário pedir disponibilidade presencial, a resposta exige informação confirmada por você.

## Executor assistido (`autonomo exec`)

Faz parte do AutoEstágio (Playwright com o Chrome/Chromium da máquina; não depende do Claude Code nem de conversa).
Para cada vaga **pronta** do fluxo assistido, em ordem de prioridade: reserva o item, abre o link oficial (só HTTPS),
classifica a página (vaga encerrada, login, desafio de CAPTCHA visível, avaliação, sem formulário), lê os campos,
escolhe o currículo aprovado da variante (PDF de `data/cv-output`, com SHA-256; senão o genérico; senão o mestre do
perfil), preenche **só dados comprovados** (`config/applicant.json`, perfil e a pretensão da política), anexa o
currículo, confere cada valor na página, tira uma captura (`data/exec/`) e **para antes do envio**.

- **Nunca envia:** a interface do navegador do executor não tem "clicar" nem "enviar".
- **Nunca marca concluída sem evidência:** com `--revisar` a janela fica aberta para você enviar; depois o executor
  procura a confirmação da plataforma e só então conclui, guardando o trecho como evidência.
- **Sem resposta específica confirmada para esta pergunta e este item, nunca preenche:** autodeclaração (gênero, raça, deficiência, orientação...), aceite de termos/LGPD, disponibilidade
  presencial, autorização de trabalho, texto livre, idiomas (mostra a dica do perfil) nem perguntas sem dado comprovado.
- **Bloqueio de uma vaga não para as demais:** login, CAPTCHA visível, avaliação, campo obrigatório desconhecido ou erro
  viram `pendente_humano` com o motivo e a execução segue; vaga encerrada é cancelada com motivo.
- **Formulários dinâmicos e listas personalizadas:** depois de preencher, o executor relê o formulário (até 3 passadas) e
  trata os campos que apareceram; reconhece listas próprias (como a do BTG) e escolhe a opção de texto exato, inclusive
  "Outra" quando o próprio formulário manda usar essa opção para instituição fora da lista. Se o componente for recriado
  depois de um anexo, ele reidentifica o campo pelo rótulo e tenta de novo.
- **Retomada:** `--item <id>` também aceita `pendente_humano`; a execução em lote continua selecionando só `pronta`. Planejar uma retomada preserva o estado pendente. Itens concluídos, cancelados ou em andamento não são retomados.
- **Documentos de identificação (CPF, RG, CNH...) nunca são digitados pelo agente.**
- **Respostas confirmadas por item:** `config/answers.json` (fora do Git; modelo em `config/answers.example.json`) vale só para o id da fila e o trecho da pergunta informado. Não autoriza envio nem é reaproveitado em outra vaga. Documentos continuam bloqueados; checkbox, radio, arquivo e texto livre exigem preenchimento humano.
- **Plataformas restritas:** LinkedIn, Indeed, Catho, InfoJobs e Sólides ficam bloqueados no executor, inclusive em redirects e subrecursos. Veja [PLATAFORMAS.md](PLATAFORMAS.md).
- Cada execução fica em `autonomous_executions` (etapas, campos com e-mail/telefone mascarados, currículo e captura).

```bash
npm run dev -- autonomo exec --planejar --max 3   # só lê e mostra o que preencheria
npm run dev -- autonomo exec --item 2             # prepara um item (preenche, anexa, captura, para)
npm run dev -- autonomo exec --revisar            # com janela: você revisa e envia; a confirmação vira evidência
npm run dev -- autonomo exec --com-janela         # janela aberta (entrar na Gupy uma vez; o login fica em data/browser-profile)
```

## Portais (verificados separadamente em 2026-10-24, páginas reais, somente leitura)

| Plataforma | Listar vagas        | Candidatura                                             | Barreira no formulário         | Fluxo     |
| ---------- | ------------------- | ------------------------------------------------------- | ------------------------------ | --------- |
| Greenhouse | API pública         | API só com chave da empresa                             | reCAPTCHA Enterprise           | assistido |
| Lever      | API pública         | API só com chave da empresa                             | hCaptcha                       | assistido |
| Ashby      | API pública         | formulário                                              | reCAPTCHA Enterprise           | assistido |
| Inhire     | página pública (JS) | formulário sem login                                    | reCAPTCHA Enterprise invisível | assistido |
| Gupy       | páginas públicas    | exige conta de candidato (e-mail/CPF, Google, LinkedIn) | login                          | assistido |

Nada é contornado e nenhuma avaliação é respondida por conta própria. Um conector de portal só vira automático se a
plataforma oferecer um caminho oficial e permitido; hoje nenhum oferece.

## As quatro categorias

`autonomo opportunities` (e o relatório) separam as vagas sem candidatura em: **elegível com candidatura
automatizável** (e-mail de candidatura utilizável), **elegível, candidatura manual** (formulário/portal),
**informações insuficientes** (falta dado obrigatório comprovado, inclusive vaga afirmativa: autodeclaração nunca é
presumida) e **incompatível**. `autonomo sources` mostra as categorias por fonte e `autonomo diagnose` mede se cada
pendência de área, modalidade e bolsa vem de anúncio genérico ou de menção que o extrator não trata como regra.

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
