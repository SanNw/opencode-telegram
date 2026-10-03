# Política de segurança

Este projeto é uma interface remota de proprietário único para uma instalação OpenCode. Não é um serviço multiusuário e não recebeu certificação independente de segurança.

## Limites de confiança

- Mantenha o Bridge e o OpenCode na interface de rede local de retorno. Somente o Bridge autenticado deve ser encaminhado pelo túnel HTTPS; nunca publique o OpenCode diretamente.
- A inicialização assinada do Telegram, a autorização do proprietário e a prova do dispositivo confiável protegem o acesso. Proteja o código local de pareamento como uma credencial; ele pode aparecer nos registros do serviço.
- A aprovação de ações do Bridge não substitui as permissões de ferramentas do OpenCode. Uma mensagem pode desencadear o uso posterior de ferramentas. Configure permissões adequadas à pasta de trabalho.
- Referências de arquivos são IDs opacos vinculados ao proprietário. A pasta configurada é um limite imposto pelo servidor, não um caminho escolhido pelo navegador.
- A prévia HTML é deliberadamente estática e isolada. Não conceda ao quadro de prévia privilégios de scripts ou de mesma origem.
- Cópias de segurança SQLite contêm dados sensíveis de autenticação, metadados e possivelmente conteúdo enviado. Criptografe-as e restrinja o acesso.
- A configuração da chave de recuperação revela uma chave de 256 bits uma única vez. Guarde-a fora do Telegram e deste computador; só é persistido um verificador scrypt com sal. A autenticação elevada concede cinco minutos de privilégio vinculados ao usuário, dispositivo e sessão atuais, não uma credencial de acesso irrestrito.
- Alterações em integrações/provedores e Git exigem autenticação elevada e aprovação explícita. Chaves de provedores ficam em memória temporária do servidor, para uso único, nunca no banco de propostas ou no resumo de aprovação. Endpoints remotos são negados por padrão, salvo autorização explícita na lista de hosts.

## Relatar vulnerabilidades

Não publique tokens, códigos de pareamento, dados assinados do Telegram, cookies, bancos ou conteúdo privado de projetos em uma ocorrência pública. Envie uma reprodução mínima em particular ao mantenedor, por um canal já estabelecido. Se o relato privado de vulnerabilidades estiver habilitado no repositório, use a área de segurança do GitHub. Não há endereço público de segurança monitorado nem prazo de resposta declarado.

## Contenção imediata

1. Com um dispositivo confiável e a chave de recuperação salva, use Segurança → Bloquear acesso remoto ou marcar a conta Telegram como comprometida. Isso revoga sessões e congela ações pendentes antes de tentar interromper ou rejeitar ações no OpenCode. Se o Mini App estiver indisponível, pare localmente `opencode-telegram-bridge.service` ou o serviço Bridge do Compose; pare o túnel se não puder isolar suas rotas com segurança.
2. Revogue no BotFather o token do bot Telegram se ele tiver sido exposto. Troque as credenciais do OpenCode se afetadas. Atualize a configuração local protegida antes de reiniciar.
3. Preserve cópias restritas dos registros e do banco relevantes para diagnóstico. Não as publique.
4. Em um ambiente confiável, revogue os dispositivos afetados e examine as alterações do OpenCode e aprovações pendentes antes de restaurar o acesso remoto.

Se não houver dispositivo confiável, mas a chave de recuperação estiver disponível, use o formulário de recuperação independente. Ele comprova a posse de uma nova chave P-256 do dispositivo, revoga dispositivos e sessões antigos e restaura o acesso sem confiar na inicialização do Telegram. Sem a chave, mantenha o acesso remoto parado e faça a recuperação administrativa local. Não exclua o banco nem contorne automaticamente a autenticação. Uma falha ao interromper o OpenCode não significa falha no bloqueio do acesso; examine a auditoria antes de retomar o trabalho.

## Critérios de publicação

Exija testes aprovados, revisão de dependências e ausência de segredos expostos antes de distribuir. A auditoria de dependências da integração contínua não é um teste de invasão. Habilite a varredura de segredos e a proteção de envio do repositório quando disponíveis; são configurações do GitHub, não ativadas por este documento. Registre os achados aceitos em vez de desabilitar a auditoria globalmente.

[Instalação](installation.md) · [Operação e cópias de segurança](operations.md)
