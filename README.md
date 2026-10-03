<p align="center"><img src="docs/media/overview.svg" alt="Telegram → Bridge seguro → OpenCode local" width="860"></p>

# OpenCode Telegram

**Seu computador trabalha. Você acompanha pelo Telegram.**

Leve o OpenCode no bolso: converse com seus agentes, escolha modelos, acompanhe o que está acontecendo e revise os resultados pelo celular ou desktop. Tudo conectado ao seu workspace — sem publicar o servidor OpenCode na internet.

Self-hosted · proprietário único · MIT · **beta**

## Do pedido ao resultado, sem sair do Telegram

- **Converse e acompanhe.** Respostas em tempo real, seleção de modelos, agentes e esforço de raciocínio.
- **Veja o que mudou.** Diffs, atividade das ferramentas, anexos, arquivos e galeria de artefatos.
- **Encontre suas integrações.** Skills, MCPs, plugins e provedores informados pelo OpenCode.
- **Mantenha o controle.** Aprovação explícita, dispositivos confiáveis e recuperação independente.
- **Use do seu jeito.** Temas claro/escuro e idioma automático: inglês, português, espanhol, chinês, francês e hindi. Textos ainda não traduzidos usam inglês; conteúdo do OpenCode não é traduzido.

## Uma interface, dois temas

Escolha claro, escuro ou acompanhe o tema do sistema. As capturas abaixo são da aplicação real com **dados fictícios de teste**, sem conversas ou credenciais pessoais.

| Escuro | Claro |
| --- | --- |
| ![Dashboard escuro](docs/media/home-dark.png) | ![Dashboard claro](docs/media/home-light.png) |

## Coloque para rodar

Escolha seu ambiente: **[Windows nativo (PowerShell, sem WSL)](docs/windows-native.md)** ou Linux/WSL abaixo. OpenCode e Bridge devem rodar no mesmo ambiente; não reutilize `node_modules` entre Windows e WSL.

### Linux / WSL

Requisitos: **Node.js 22+, OpenCode, bot do Telegram e URL HTTPS** apontando somente para o Bridge. O computador precisa permanecer ligado e conectado.

```bash
git clone https://github.com/SanNw/opencode-telegram.git
cd opencode-telegram
npm ci
cp .env.example .env
```

Edite `.env`: `TELEGRAM_BOT_TOKEN`, `TELEGRAM_OWNER_ID`, `TELEGRAM_MINI_APP_URL` e uma pasta autorizada em `OPENCODE_DIRECTORY`. Se o OpenCode usar senha, configure as credenciais correspondentes. **Nunca publique esse arquivo.**

```bash
npm run build
# Terminal 1
opencode serve --hostname 127.0.0.1 --port 4096
# Terminal 2, na pasta do repositório
npm start
```

Encaminhe sua URL HTTPS para `http://localhost:8787`, configure o botão do Mini App no BotFather e abra pelo Telegram. Pareie com o código de uso único mostrado no terminal do Bridge. Não publique a porta do OpenCode nem a do Vite.

**[Instalação detalhada](docs/installation.md)** · [Segurança](SECURITY.md) · [Operação e backup](docs/release-readiness.md)

## Antes de começar: o que esta beta promete

- Não é multiusuário. OpenCode e Bridge permanecem em loopback.
- Skills/plugins são consultivos no contrato testado; mudanças de MCP são runtime-only.
- É uma beta, não uma certificação de segurança. Aceitação física e revisão independente continuam necessárias.
- Docker é opcional, validado apenas em Linux. Windows/macOS não são hosts de container validados.

## Desenvolvimento

```bash
npm run check
npm test
npm run build
npm run test:runtime
CHROME_BINARY=/caminho/para/chrome npm run test:browser
```

[Testes de navegador](docs/browser-validation.md) · [Aceitação Telegram](docs/telegram-acceptance.md) · [Especificação](PROJECT_SPEC.md) · [Licença MIT](LICENSE)
