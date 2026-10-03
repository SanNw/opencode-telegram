# Prontidão de publicação e operação

## Escopo e evidências

A instalação atual é um ambiente WSL/Linux de proprietário único, com servidor OpenCode externo e túnel Cloudflare. A compilação da imagem Linux, a execução com sistema de arquivos somente leitura e o teste isolado de disponibilidade foram bem-sucedidos. Isso não demonstra suporte a contêineres Windows/macOS nem operação autenticada em contêiner. Reconexão, teclado e recuperação de dispositivo no Telegram Android/Desktop continuam exigindo aceitação física; uma resposta HTTP de disponibilidade não valida uma conversa autenticada.

A instalação Windows nativa está descrita em [Windows nativo](windows-native.md). Em 03/10/2026, uma instalação isolada com Node 22.18 concluiu `npm ci`, sem achados na auditoria, 101 testes do Bridge e 34 do Mini App, verificação de tipos e compilação de produção. Essa evidência histórica não valida Docker Desktop, autenticação física do Telegram, tarefas de início de sessão ou inferência do OpenCode no Windows. Posteriormente, o [CI do commit f0e1296](https://github.com/SanNw/opencode-telegram/actions/runs/37151119130) passou nos executores Linux e Windows nativo; o número de testes aumentou desde a verificação inicial.

## Implantação opcional em contêiner — somente Linux

O Dockerfile compila e testa os dois componentes e executa com usuário sem privilégios. O Compose usa **rede do host** porque o Bridge só aceita conexões na interface local de retorno. Não publica uma porta do host nem instala OpenCode/cloudflared. A rede do host reduz o isolamento; use-a somente em um computador Linux confiável de proprietário único. Docker Desktop/Windows/macOS não foram validados para esta configuração.

1. Instale e configure OpenCode e cloudflared no mesmo computador Linux. Mantenha o OpenCode autenticado e na interface local de retorno.
2. Crie `.env` a partir de `.env.example`, configure as credenciais do proprietário, URL/senha do OpenCode e o caminho absoluto `OPENCODE_DIRECTORY` usado pelo servidor externo. Nunca versione `.env`.
3. Monte a pasta de trabalho **no mesmo caminho absoluto**, em modo somente leitura. Ela deve ser legível pelo UID 1000 do contêiner. Não monte `/`, uma pasta pessoal inteira, o soquete do Docker nem pastas amplas com dados sensíveis. Não use `/app` ou uma pasta superior como área de trabalho; `/app` é reservado para a imagem.
4. Execute `docker compose config --quiet` e depois `docker compose build`. Não exiba a configuração resolvida sem `--quiet`: ela contém segredos.
5. Antes de trocar uma implantação existente, faça uma cópia de segurança e pare o Bridge anterior para evitar conflito de portas. O Compose usa um volume de banco separado; não importa automaticamente o banco ou os dispositivos anteriores.
6. Execute `docker compose up -d`. Confira `docker compose ps` e teste disponibilidade e uma sessão autenticada do Telegram. Consulte os registros de inicialização localmente para recuperar o código de pareamento.

A montagem somente leitura limita o acesso do Bridge aos arquivos, não a capacidade de edição do OpenCode executado separadamente. O volume `bridge-data` permanece após `docker compose down`; não use `down --volumes` salvo se quiser explicitamente destruir o estado armazenado.

## Cópias de segurança e restauração

Use a API de cópia de segurança online do SQLite ou `sqlite3 DATABASE '.backup BACKUP'`, com caminhos explícitos e validados, destino único e permissões restritas. **Não copie apenas o arquivo `.sqlite` ativo** enquanto houver gravações no registro WAL. Confira `PRAGMA integrity_check` na cópia. Guarde a configuração protegida separadamente e mantenha ambos fora do Git e de locais públicos.

Nesta cópia do repositório, `node deploy/backup-bridge.mjs` usa o banco configurado e cria um destino único com data/hora em `data/backups`. Usa a API online do SQLite, restringe o arquivo ao modo 0600 e verifica sua integridade. O argumento opcional de destino deve indicar um local privado; arquivos existentes nunca são sobrescritos. O programa não imprime configuração nem credenciais.

Restaure somente durante uma parada planejada, com o Bridge interrompido. Preserve o banco atual e os arquivos WAL/SHM associados como um conjunto recuperável antes de substituí-los. Confira a integridade da cópia e a compatibilidade do esquema com a versão escolhida; restaure proprietário e permissões antes de reiniciar. Nunca misture arquivos WAL do banco anterior com o restaurado. Não reverta o código sem verificar uma migração de esquema. Teste a restauração em uma instância separada, sem túnel público, antes de depender dela.

## Atualizações e desinstalação

Antes de atualizar: registre a versão, faça cópias de segurança, execute verificações/testes/compilação, revise as migrações e os achados de dependências aceitos; depois reinicie e teste autenticação, respostas em tempo real e anexos. Guarde a compilação anterior e a cópia pré-atualização para recuperação controlada. Uma resposta de disponibilidade do serviço não comprova inferência.

Para desinstalar: pare o Bridge e sua rota dedicada do túnel; desabilite somente os serviços criados para este projeto. Preserve dados e cópias de segurança por padrão. Não exclua a instalação OpenCode, as pastas de trabalho, outras rotas Cloudflare nem credenciais compartilhadas.

## Limites das funcionalidades

A chave de recuperação, as sessões elevadas de cinco minutos e o bloqueio de emergência estão implementados no Bridge. Guarde a chave fora do Telegram e desta instalação: ela aparece uma única vez, e o banco armazena somente um verificador scrypt com sal. A recuperação cria um novo dispositivo confiável e revoga os anteriores e suas sessões; não contorna a prova do dispositivo. O bloqueio primeiro congela o acesso e depois tenta interromper o OpenCode e rejeitar permissões pendentes. Uma falha nessa interrupção é auditada e não desfaz o bloqueio.

O catálogo expõe Skills, servidores MCP, plugins e provedores normalizados, com dados sensíveis removidos. Conectar/remover chaves de API exige uma ação elevada e aprovada; a chave enviada permanece em memória por cinco minutos e deve ser reenviada após reinício ou expiração. A configuração de Skills/plugins é somente leitura no contrato testado. Mudanças de MCP valem somente durante a execução, sem garantia de persistência após reinício. Adicionar endpoints remotos exige uma entrada exata em `MANAGEMENT_ALLOWED_HOSTS` e validação de HTTPS/DNS público; a lista vazia padrão impede a adição. Esses limites devem permanecer visíveis no Mini App.

A galeria de artefatos limita-se aos anexos autorizados das mensagens OpenCode, com IDs opacos que expiram. Não expõe caminhos arbitrários nem trata arquivos enviados ao armazenamento como artefatos gerados. A prévia HTML usa o isolamento existente.

Commit, pull e push do Git exigem elevação e aprovação. Commits selecionam caminhos alterados explícitos e rejeitam alterações preparadas não relacionadas. Pull permite somente avanço direto, sem mesclagem. Push usa uma única branch remota validada e rejeita configurações de espelhamento ou envio personalizado. Aprovar uma ação é uma decisão do usuário, não permissão para envios automáticos.

Testes de dimensão da janela e ciclo de vida são evidências da aplicação web. Teclado, suspensão e recuperação real de sessão assinada no Telegram Android/Desktop ainda exigem a matriz de aceitação física; simulações de tamanho ou respostas HTTP não as substituem.

## Critérios de distribuição

- O CI deve passar em um executor Linux limpo, incluindo dependências nativas e compilação da imagem.
- Execute o contêiner em uma instalação descartável; verifique rede local, propriedade do banco persistente, disponibilidade, pareamento, respostas e arquivos antes de substituir produção.
- Execute a matriz real Telegram: perda de rede, segundo plano/retorno, autenticação expirada, área obstruída pelo teclado, dispositivo revogado e resposta longa.
- Teste reinício do serviço/computador e restauração de cópias. Registre plataforma, versão e resultados, não suposições.
- Conclua uma revisão independente de segurança e documente os achados. A varredura de segredos e proteção de envios do GitHub devem ser habilitadas separadamente quando disponíveis.
- O proprietário escolheu MIT, e o repositório é público como beta. Não implique certificação formal nem prazo contratual de suporte.

## Pendências e limites de escopo

| Item | Situação / evidência necessária |
| --- | --- |
| Dependências, caminhos, testes e compilação no Windows nativo | Validados localmente e no CI do commit f0e1296; isso não substitui o teste físico. |
| Comportamento real Telegram Android/Desktop | Matriz física necessária; resultados simulados não a encerram. |
| Início de sessão, reinicialização e reconexão do túnel no Windows | Exige instalação nativa configurada e teste real; produção WSL não foi migrada. |
| Restauração de cópia de segurança | Deve ser exercitada em instância descartável antes de depender dela. |
| Revisão independente de segurança | Revisão externa pendente, não uma declaração do implementador. |
| Traduções | Seis idiomas; conteúdo externo ou texto desconhecido não é traduzido automaticamente. |
| Edição de Skills/plugins e configuração persistente de MCP | Exige contrato de escrita compatível, validação e aprovação explícita. Não edite configuração bruta para simular recursos indisponíveis. |
| Proprietário único / rede local / lista exata de hosts | Limites intencionais. Multiusuário ou exposição de rede exige modelo de ameaças separado. |
| Docker Desktop/macOS | Não validado; instruções Windows nativo não demonstram portabilidade de contêiner. |

Não declare o projeto concluído removendo essas ressalvas. Cada item dependente de validação precisa de evidência datada; os recursos dependentes do OpenCode precisam de contrato testado.

O relatório inicial de implementação é histórico, não uma matriz atual de funcionalidades. Leia capacidades de execução, testes atuais e especificação normativa em conjunto; recursos indisponíveis devem permanecer explicitamente indisponíveis.

[Instalação](installation.md) · [Segurança](security.md)
