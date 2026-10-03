<p align="center"><img src="docs/media/overview.svg" alt="Telegram → Bridge seguro → OpenCode local" width="860"></p>

# OpenCode Telegram

**Seu OpenCode no Telegram.** Converse com os agentes do seu computador, escolha modelos, acompanhe tarefas e alterações e consulte arquivos pelo celular — sem publicar o servidor OpenCode na internet.

Self-hosted · proprietário único · MIT · **beta**

## Recursos

- Conversas em tempo real, modelos, agentes e esforço de raciocínio.
- Diffs, ferramentas, anexos, arquivos e galeria de artefatos.
- Skills, MCPs, plugins e provedores informados pelo OpenCode.
- Aprovação explícita, dispositivos confiáveis e recuperação independente.
- Temas claro/escuro e idioma automático: inglês, português, espanhol, chinês, francês e hindi. Textos ainda não traduzidos usam inglês; conteúdo do OpenCode não é traduzido.

## Mini App

Screenshots da aplicação real com **dados fictícios de teste**, sem conversas ou credenciais pessoais.

| Escuro | Claro |
| --- | --- |
| ![Dashboard escuro](docs/media/home-dark.png) | ![Dashboard claro](docs/media/home-light.png) |

## Instalação · Linux / WSL

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

## Limites

- Não é multiusuário. OpenCode e Bridge permanecem em loopback.
- Skills/plugins são consultivos no contrato testado; mudanças de MCP são runtime-only.
- É uma beta, não uma certificação de segurança. Aceitação física e revisão independente continuam necessárias.
- Docker é opcional, validado apenas em Linux. Windows/macOS não são hosts de container validados.

## Desenvolvimento

```bash
npm run check
npm test
npm run build
CHROME_BINARY=/caminho/para/chrome npm run test:browser
```

[Testes de navegador](docs/browser-validation.md) · [Aceitação Telegram](docs/telegram-acceptance.md) · [Especificação](PROJECT_SPEC.md) · [Licença MIT](LICENSE)
