# Instalação em Linux / WSL

Para instalação sem WSL, siga [Windows nativo (PowerShell)](windows-native.md). Não compartilhe `node_modules` entre sistemas operacionais.

## Preparar

Instale Node.js 22+, Git e OpenCode. Execute OpenCode e Bridge no mesmo Linux/WSL. A interface pode ser acessada pelo Telegram em outros sistemas, mas isso não significa que todos os hosts de instalação tenham sido validados.

Clone o repositório, execute `npm ci` e copie `.env.example` para `.env`.

| Variável | Valor |
| --- | --- |
| `TELEGRAM_BOT_TOKEN` | Token criado no BotFather; mantenha privado |
| `TELEGRAM_OWNER_ID` | ID numérico do proprietário |
| `TELEGRAM_MINI_APP_URL` | URL pública HTTPS do Mini App |
| `OPENCODE_DIRECTORY` | Caminho absoluto de uma pasta de projeto autorizada, não de todo o disco |
| `OPENCODE_URL` | Servidor local; padrão `http://127.0.0.1:4096` |
| `OPENCODE_SERVER_USERNAME` / `OPENCODE_SERVER_PASSWORD` | Mesmas credenciais do OpenCode, se configuradas |

Não ative `ALLOW_INSECURE_LOCAL_DEV` em instalações expostas por túnel. Não compartilhe `.env`, bancos, backups, cookies ou códigos de pareamento.

## Executar

Faça `npm run build`. Em um terminal, execute `opencode serve --hostname 127.0.0.1 --port 4096`; em outro, execute `npm start` na pasta do repositório. O Bridge entrega API e Mini App pela porta 8787.

Para confirmar somente disponibilidade: `curl http://127.0.0.1:8787/api/v1/system/health`. Health não confirma autenticação nem resposta do modelo.

## HTTPS e Telegram

Configure um túnel/reverse proxy HTTPS que encaminhe **somente** `http://localhost:8787`. Não publique OpenCode na 4096 ou Vite na 5173. Domínio e túnel devem pertencer à sua instalação.

No BotFather, configure o botão de menu para a URL HTTPS do Mini App. Abra pelo botão e use o código de pareamento mostrado no terminal do Bridge. Depois de parear, teste uma mensagem e sua aprovação.

## Proteger e manter

Configure a chave de recuperação na Central de Segurança e guarde-a fora do Telegram. Configure as permissões do OpenCode: a aprovação do Bridge não substitui as permissões de ferramentas do agente.

Para serviço persistente, adapte caminhos e usuário nos exemplos em `deploy/systemd/`; não são instalados automaticamente. Faça backup antes de atualizar. Consulte [operação](release-readiness.md) e [segurança](../SECURITY.md).
