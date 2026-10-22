# Objetivo do produto e critérios de aceitação

## Objetivo

O AutoEstágio deve realizar **candidaturas reais e automáticas** a estágios em TI, e não apenas
encontrar vagas ou gerar rascunhos. O projeto **não está concluído** até que a automação de
candidaturas tenha sido efetivamente implementada e validada, ou até que suas limitações técnicas
estejam documentadas (ver [Definição de pronto](#definição-de-pronto)).

## Fluxo-alvo

1. **Buscar** novas vagas de estágio em TI.
2. **Filtrar** por compatibilidade com o perfil.
3. **Consultar o histórico** para evitar candidaturas duplicadas.
4. **Preparar e preencher** a candidatura com dados verdadeiros.
5. **Anexar** o currículo atualizado.
6. **Enviar automaticamente** pelos canais que permitirem essa operação.
7. **Verificar a confirmação** de envio.
8. **Registrar o resultado** no SQLite.

## Modos de operação

| Modo        | Comportamento                                                               |
| ----------- | --------------------------------------------------------------------------- |
| **dry-run** | Executa o fluxo até o fim sem enviar nada. É o padrão.                      |
| **revisão** | Prepara e preenche; o envio só ocorre após aprovação individual do usuário. |
| **auto**    | Envia candidaturas elegíveis sem confirmação individual, após ativação.     |

Regras do modo `auto`:

- Desabilitado por padrão e só ativado por ação **explícita** do usuário.
- Só envia onde a integração e as regras da plataforma permitirem a automação.
- Respeita o limite diário de envios (`MAX_APPLICATIONS_PER_DAY`) e a deduplicação.

## Interrupção obrigatória (intervenção humana)

Se ocorrer qualquer um dos casos abaixo, a candidatura **é interrompida** e marcada como
`pendente_intervencao_humana`, com o motivo registrado. O sistema não tenta contornar nada.

- CAPTCHA.
- Autenticação adicional (2FA, verificação de e-mail ou telefone).
- Pergunta do formulário sem resposta conhecida no perfil.
- Restrição de automação (termos da plataforma, bloqueio, `robots.txt`, HTTP 401/403).
- Confirmação de envio que não pôde ser verificada.

## Critérios de aceitação por fase

Os números das fases seguem o roteiro do README e podem ser reordenados com autorização.

### Descoberta (Fase 2, em andamento)

- [x] Cliente HTTP com timeout, retry, `Retry-After`, rate limit por host e `robots.txt` (2.1).
- [ ] Adaptadores independentes e testados com dados simulados.
- [ ] Normalização e deduplicação de vagas entre fontes.

### Análise e elegibilidade

- [ ] Nota de compatibilidade com o perfil, com justificativa.
- [ ] Regras do perfil aplicadas: bolsa mínima de R$ 1.200 e modalidade.
- [ ] Vaga sem valor de bolsa fica **pendente de análise**.
- [ ] Presencial fica com deslocamento **pendente de análise**; nenhum tempo de trajeto é inventado.
- [ ] Cada vaga recebe um estado de elegibilidade explicável: elegível, pendente ou descartada.

### Histórico e deduplicação de candidaturas

- [ ] Nenhuma vaga recebe duas candidaturas, nem quando aparece em fontes diferentes.
- [ ] A consulta ao histórico acontece **antes** de preparar qualquer candidatura.
- [ ] O teste prova que uma segunda execução não reenvia nada (idempotência).

### Preparação

- [ ] Respostas do formulário vêm somente de dados verdadeiros do perfil; nada é inventado.
- [ ] Pergunta sem resposta conhecida interrompe a candidatura (ver seção acima).
- [ ] Currículo atualizado, com versão e _hash_ registrados a cada candidatura.
- [ ] Modos `dry-run` e `revisão` funcionam de ponta a ponta, sem envio externo no `dry-run`.

### Envio e confirmação

- [ ] Canais de envio avaliados um a um (termos, API ou formulário, viabilidade técnica), com a
      decisão documentada. Um canal sem permissão clara não é automatizado.
- [ ] A confirmação de envio é **verificada** (página, e-mail ou resposta da API), e não presumida.
- [ ] Resultado registrado no SQLite: estado, data, canal, evidência da confirmação e motivo de
      qualquer interrupção. As transições ficam em `application_events`.
- [ ] Falha parcial nunca deixa a vaga marcada como enviada sem confirmação.

### Modo automático

- [ ] Ativação explícita e registrada; desligado por padrão.
- [ ] Limite diário de envios e intervalos entre candidaturas respeitados.
- [ ] Interrupção correta em todos os casos da lista de intervenção humana.
- [ ] Parada de emergência: um comando ou arquivo que desativa o modo `auto` imediatamente.
- [ ] Relatório de cada execução: enviadas, interrompidas, puladas por duplicidade e erros.

### Validação ponta a ponta

1. **Ambiente controlado.** Um formulário e uma vaga de teste locais, sob controle do projeto,
   percorrem o fluxo inteiro (itens 1 a 8) nos três modos, incluindo os cenários de CAPTCHA,
   pergunta desconhecida, duplicidade e falha de confirmação.
2. **Candidatura real autorizada.** Depois do passo 1, e só com **autorização expressa do usuário
   para uma vaga específica**, uma candidatura real valida o fluxo completo e a verificação da
   confirmação. O resultado fica registrado.
3. Playwright só entra se um canal aprovado exigir renderização de JavaScript, com a necessidade
   comprovada antes da instalação.

## Definição de pronto

O projeto só é considerado concluído quando **uma** das condições abaixo for verdadeira:

- **(a)** O fluxo completo está implementado e validado pelos dois testes de ponta a ponta acima, em
  ao menos um canal que permita a automação; **ou**
- **(b)** As limitações técnicas ou contratuais que impedem a automação em cada canal estão
  documentadas, com a evidência, e o restante do fluxo (busca, filtro, histórico, preparação e
  registro) está implementado e validado.

Enquanto nenhuma das duas se cumprir, o projeto continua em andamento, mesmo que as fases
anteriores estejam entregues.

## Restrições permanentes

- Nenhum envio real sem autorização do usuário: o modo `auto` exige ativação explícita, e a
  primeira candidatura real exige autorização para a vaga específica.
- Sem acesso a contas de recrutamento de terceiros e sem contornar CAPTCHA, login ou bloqueios.
- Respeito aos termos de uso e às permissões de cada plataforma.
- Dados pessoais e currículos ficam fora do Git (`data/` e `config/profile.json`).
