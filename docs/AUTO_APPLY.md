# AUTO_APPLY: envio autônomo com autorização verificável

Implementado para **e-mail pela API oficial do Gmail**. Vem desligado (`AUTO_APPLY=off`), sem manifesto de produção,
sem criar concessões e sem habilitar envio real. O executor de navegador continua sem operação de envio.

## Canais e evidência oficial consultada

Pesquisa documental em 24/10/2026 (São Paulo). A disponibilidade de um formulário, `robots.txt` ou um endpoint acessível
não é tratada como autorização.

| Canal                    | Documentação oficial                                                                                                                                                                                                   | Decisão operacional                                                                                                                                         |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Gmail API                | [Visão geral](https://developers.google.com/workspace/gmail/api/guides) inclui envio programático; [messages.send](https://developers.google.com/workspace/gmail/api/guides/sending) descreve MIME e envio autenticado | Transporte implementado. Exige convite atual da vaga para e-mail corporativo e evidência do empregador autorizando automação, revisada e arquivada por vaga |
| Greenhouse Job Board API | [Autenticação e envio](https://docs.greenhouse.io/job-board.html): GET público; POST de candidatura exige Job Board API Key                                                                                            | API de candidatura documentada para integração da empresa; sem chave/autorização da empresa, não utilizável pelo AutoEstágio. Sem novo conector de envio    |
| Lever Postings API       | [Documentação oficial](https://github.com/lever/postings-api): POST exige chave criada por Super Admin; resposta inclui applicationId                                                                                  | Condicional à autorização/credencial da empresa. Não usar formulário hospedado como alternativa nem contornar hCaptcha. Sem conector de envio habilitado    |
| Ashby                    | [Autenticação](https://developers.ashbyhq.com/reference/authentication) e [carreiras próprias](https://developers.ashbyhq.com/docs/creating-a-custom-careers-page) documentam API key e applicationForm.submit         | Condicional à autorização/credencial da empresa e às perguntas/consentimentos. Sem conector de envio habilitado                                             |
| SmartRecruiters          | [Application API](https://developers.smartrecruiters.com/docs/application-api): clientes/parceiros, endpoints protegidos e escopo candidate_applications_manage                                                        | Não há credencial/autorização disponível neste projeto. Não implementado como canal de envio                                                                |

A permissão do Gmail cobre o transporte, **não substitui a permissão do empregador**. Também se aplicam as
[políticas de dados do Google Workspace](https://developers.google.com/workspace/workspace-api-user-data-developer-policy).
LinkedIn, Indeed, Catho, InfoJobs e Sólides continuam fora da automação conforme [PLATAFORMAS.md](PLATAFORMAS.md).

## Manifesto limitado por vaga

`config/auto-apply.json` fica fora do Git. O exemplo seguro é [auto-apply.example.json](../config/auto-apply.example.json),
desligado e sem vagas. Cada entrada autoriza apenas um id de vaga, canal e destinatário; vincula o conteúdo da vaga,
perfil e currículo pelos hashes. Exige revisão humana, validade e artefato de permissão com SHA-256. `revokedAt` revoga
a entrada. Modificar o manifesto invalida a concessão, pois seu SHA-256 integral faz parte da política autorizada.

Uma entrada ilustrativa (todos os valores devem vir da revisão; não copiar como autorização real):

```json
{
  "jobId": 123,
  "channel": "email",
  "jobContentHash": "SHA-256 de jobs.content_hash exibido pelo diagnóstico",
  "profileHash": "hash de 16 caracteres exibido pelo diagnóstico",
  "cvSha256": "SHA-256 completo do currículo aprovado",
  "recipient": "recrutamento@empresa.exemplo.com.br",
  "reviewedAt": "2026-10-24T12:00:00-03:00",
  "validUntil": "2026-10-25T12:00:00-03:00",
  "noAdditionalQuestionsOrConsents": true,
  "permission": {
    "kind": "written_authorization",
    "sourceUrl": "https://empresa.exemplo.com.br/autorizacao",
    "issuerDomain": "empresa.exemplo.com.br",
    "artifactPath": "../data/permissions/autorizacao-empresa.txt",
    "artifactSha256": "SHA-256 do documento real arquivado",
    "explicitlyAllowsAutomation": true,
    "reviewedAt": "2026-10-24T12:00:00-03:00"
  }
}
```

`permission.kind` também aceita `official_documentation`. A URL deve pertencer ao domínio emissor; autorizações
recebidas por e-mail podem usar a URL da mensagem no Gmail. O domínio emissor deve corresponder ao destinatário.
O programa verifica o artefato e seus vínculos; a decisão de que o texto realmente autoriza esse escopo precisa ser
feita pela pessoa. Um booleano isolado ou um arquivo inventado não demonstra autorização de terceiros.

O protocolo implementado é CV aprovado + mensagem factual gerada com dados comprovados do perfil. Perguntas adicionais,
textos livres, documentos extras e consentimentos ficam para uma pessoa, mesmo que o envio por e-mail seja permitido.
`noAdditionalQuestionsOrConsents` é a revisão explícita desse ponto. Não existe inferência de que perguntas não existem.
O conteúdo da vaga precisa permanecer idêntico ao revisto. **Vagas novas sem entrada revista ficam pendentes**.

## Portões e envio

AUTO_APPLY exige elegibilidade `apto` com perfil atual e todos os critérios obrigatórios atendidos. Não usa a tolerância
de bolsa/modalidade desconhecidas para enviar. Mesmo um destinatário previamente verificado precisa corresponder ao
convite único e corporativo ainda escrito na descrição atual.

No envio real, exige simultaneamente: `ALLOW_AUTO_APPLY=true`, política ligada, `real.authorized=true`, canal `email`,
hash do manifesto em `real.autoApplyManifestSha256`, concessão vigente da política atual, currículo aprovado e
`EMAIL_SEND_ENABLED=true`. Qualquer portão ausente bloqueia. O comando legado `autonomo run --real` também passa pelo
manifesto quando usado pela CLI; não é uma alternativa para evitar essas verificações.

Reutiliza o fluxo de e-mail existente: preparo sem pendências, revisão delegada ao escopo autorizado, teste prévio para
a própria caixa, autorização de uso único, reserva atômica, limite diário móvel de 24 h, intervalo mínimo de 15 min,
prevenção de equivalência/duplicidade e transporte sem retentativa. Concessão, perfil, manifesto, prova e arquivo de
parada são revalidados antes da reserva de cada envio, incluindo após o teste prévio ou uma espera. Revogação impede
novas reservas; não desfaz uma mensagem já entregue ao provedor.

## Estados, histórico e comprovantes

O diagnóstico expõe `descoberta`, `preparada`, `enviada`, `confirmada` e `pendente_humano`, derivados dos registros reais.
`descoberta` identifica vaga ainda sem candidatura/preparo local; a análise e os motivos de descarte continuam separados.

- `enviada`: Gmail aceitou e retornou identificador; não comprova leitura/recebimento pelo recrutador.
- `confirmada`: há evidência de recebimento e a candidatura está em `entrega_confirmada`.
- Resultado incerto: `pendente_humano`, sem nova tentativa automática.

Os eventos continuam em `application_events`, o transporte em `email_dispatches` e as decisões em `autonomous_decisions`.
`data/auto-apply-evidence/run-<id>-job-<id>.json` arquiva o aceite ou resultado incerto, id de mensagem, ids da candidatura
e os hashes de permissão/manifesto. Os arquivos são 0600. O relatório da madrugada inclui estados e bloqueios.

## Revisar e autorizar futuramente — não executado nesta entrega

1. Rodar `npm run dev -- autonomo auto-apply --json` para ver hashes, convites por e-mail e motivos. Obter e revisar
   a autorização aplicável de cada empregador. Montar o manifesto com validade curta e apenas as vagas revistas.
2. Ensaiar com `AUTO_APPLY=simulate EMAIL_SEND_ENABLED=false npm run dev -- autonomo run --auto-apply --no-scan --json`.
   Não cria candidatura nem chama o transporte. Conferir `data/reports/latest.md/json` e a mensagem factual do gerador.
3. Somente depois da revisão, configurar a política com regras restritas, limites pequenos, canal `email` e
   `real.autoApplyManifestSha256` igual ao hash integral do manifesto exibido no diagnóstico. Ativar `enabled` e
   `real.authorized` apenas quando decidir autorizar.
4. `autonomo grant --days 1` mostra o resumo e código. Somente o comando posterior com `--confirm <código>` e
   `--reason "<motivo da autorização>"` grava a concessão limitada. Nenhuma concessão foi criada nesta entrega.
5. Configurar OAuth `gmail.send`, caixa de teste e currículo aprovado. Depois da autorização explícita, usar
   `AUTO_APPLY=real`, `ALLOW_AUTO_APPLY=true` e `EMAIL_SEND_ENABLED=true`. `APPLY_MODE=auto` também exige esses opt-ins.
   O serviço noturno existente lê essas opções e entra no caminho autorizado, sem precisar de conversa aberta.

Para revogar: `autonomo revoke <id> --reason "..."`; para interromper: `autonomo stop`. Para desligar próximas execuções:
`AUTO_APPLY=off` e `EMAIL_SEND_ENABLED=false`. Não foi alterado o timer, o serviço instalado, `.env` ou a política real.

## Teste sem candidatura real

`tests/autonomy/auto-apply.test.ts` usa apenas dados fictícios, banco temporário e transporte falso. O teste de integração
abre um formulário em localhost com Chromium, preenche e anexa o PDF fictício, deixa termos desmarcados e usa um servidor
local como substituto da API Gmail. O endpoint de produção não é chamado. Testa aceite, estado enviado sem confirmação,
incerteza sem reenvio, limite, revogação durante a execução, arquivo alterado, perguntas/consentimentos e ausência de prova.

```bash
AUTOESTAGIO_AUTO_APPLY_TEST_OUTPUT="$PWD/data/reports/auto-apply-local" npm test -- tests/autonomy/auto-apply.test.ts
```

O modo de teste `real` existe apenas no banco isolado, com concessões fictícias e transporte local. Não altera as
autorizações nem envia mensagens reais da conta do usuário.
