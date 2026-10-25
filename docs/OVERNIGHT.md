# Rotina noturna: descoberta e preparação sem conversa aberta

O serviço `autoestagio-autonomo.service`, acionado pelo timer existente, executa:

```bash
node --import tsx src/cli/index.ts autonomo run --trigger timer --prepare
```

Coleta nas fontes configuradas → análise de elegibilidade → política → fila → preparação headless → relatório.
O processo inteiro mantém a mesma trava de `autonomous_runs`. Falha de uma fonte ou bloqueio de uma vaga não impede
as demais. A preparação processa até `limits.maxPerRun` itens novos, em prioridade, e nunca reabre automaticamente
`pendente_humano`, `concluida` nem vagas com registro em `applications`.

## O que é real e o que é simulado

- Sem `--real`, o **envio é simulado**. Com `--prepare`, o preenchimento e o upload de currículo nos formulários são reais,
  mas o executor não tem operação de envio. `--plan-preparation` permite somente leitura e planejamento.
- A execução agendada não usa prompt, janela de revisão, conversa aberta nem login interativo. Usa perfil de navegador
  próprio em `data/browser-profile-nightly`. O navegador é fechado ao final para não deixar processos acumulados.
- Campos preenchidos não são rascunhos garantidamente salvos pelo portal. A captura e o registro local comprovam o preparo;
  a revisão/envio posterior pode exigir repor os dados. O relatório explicita essa limitação.
- Formulários conhecidos de Greenhouse, Lever e Ashby são os hosts aceitos no preparo agendado. URLs de outras plataformas
  vão para revisão; redirects de navegação a hosts fora dessa lista também são bloqueados. A lista não autoriza envio por API.
- LinkedIn, Indeed, Catho, InfoJobs e Sólides continuam bloqueados pelo executor. A coleta usa somente os adaptadores
  existentes: Greenhouse, Lever e Ashby. Sólides permanece exclusivamente offline; veja [PLATAFORMAS.md](PLATAFORMAS.md).

## Dados, currículo e decisões humanas

- Só usa dados comprovados de `config/applicant.json`, perfil e pretensão salarial da política.
- A rotina agendada não carrega `config/answers.json`: termos/privacidade, autodeclarações, documentos, disponibilidade,
  perguntas livres e outras decisões pessoais continuam pendentes. A autorização específica da Artefact #3 não se estende
  a outras vagas nem ao agendamento.
- No agendamento, só anexa o currículo mestre cuja aprovação do perfil e SHA-256 conferem com o arquivo no disco.
  Não escolhe PDFs de variantes apenas por nome/data. Sem aprovação válida ou upload recusado, registra a pendência.
- Login, CAPTCHA visível, avaliação, campo obrigatório desconhecido, plataforma sem revisão e falhas viram
  `pendente_humano`. Captura a página bloqueada quando ela estiver disponível; registra falha da captura quando necessário.
- Uma reserva abandonada por mais que `limits.lockTtlMinutes` vira pendência humana, para não repetir ações incertas.
  `autonomo stop` é conferido antes do preparo, entre vagas e entre preenchimentos.

## Relatório para consultar ao acordar

`data/reports/latest.md` e `latest.json` trazem contagens, decisões, pendências, capturas e a fila atualizada. Cada execução
também preserva `run-<id>.md/json`. A escrita usa arquivo temporário e renomeação, com permissão 0600.
`autonomous_runs.summary` contém coleta e preparo; `autonomous_executions` guarda os campos, erros e evidências por vaga.

```bash
npm run dev -- autonomo history --limit 5
npm run dev -- autonomo queue list
systemctl --user status autoestagio-autonomo.timer
journalctl --user -u autoestagio-autonomo.service --since today
```

## Envios automáticos compatíveis

O canal implementado continua sendo e-mail corporativo explicitamente publicado pela vaga, enviado pela API oficial do
Gmail. Reutiliza a concessão vigente, a política congelada, limites por execução/dia, intervalo, verificação de destinatário,
preparo/revisão, teste prévio, autorização de uso único, reserva atômica e registro do aceite. Resultado incerto exige
intervenção e não é reenviado. Os testes desse caminho usam Gmail falso.

O serviço instalado nesta etapa não tem `--real`. Não foram alteradas concessões nem `real.authorized`; não há envio real
durante o desenvolvimento. Para envio real futuro, todos os portões já existentes precisam estar satisfeitos, incluindo
`EMAIL_SEND_ENABLED`; veja [AUTONOMY.md](AUTONOMY.md) e [SEND_RUNBOOK.md](SEND_RUNBOOK.md).

## Validação antes de atualizar o serviço

O teste `tests/autonomy/overnight.test.ts` roda sem intervenção e sem rede externa: cliente HTTP com respostas sintéticas
no formato da API Greenhouse, adaptador real, banco isolado, análise e fila reais e Chromium com HTML local. Verifica
preenchimento, upload, captura, bloqueios, continuidade, ausência de termos aceitos, ausência de envio e de concessões,
e que uma segunda execução não retoma as pendências. O teste pode preservar o relatório e as capturas:

```bash
AUTOESTAGIO_SIMULATION_OUTPUT="$PWD/data/reports/overnight-simulation" npm test -- tests/autonomy/overnight.test.ts
```

As unidades são geradas em `data/systemd-staged` e verificadas antes de atualizar a produção. Só o `ExecStart` do serviço
existente ganha `--prepare`; o timer, os horários, seu estado habilitado e as autorizações permanecem iguais.
