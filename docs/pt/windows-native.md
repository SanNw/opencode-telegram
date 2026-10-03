# Windows nativo — sem WSL

Este fluxo não usa Docker nem systemd. Execute tudo no PowerShell do Windows, com Node.js 22 LTS ou superior e Git para Windows instalados. O OpenCode documenta instalação nativa por npm, Scoop e Chocolatey, embora recomende WSL para compatibilidade máxima: [documentação oficial](https://opencode.ai/docs/).

## 1. Preparar

Abra um novo PowerShell depois de instalar Node/Git e confira:

```powershell
node --version
npm.cmd --version
git --version
npm.cmd install -g opencode-ai
opencode --version
git clone https://github.com/SanNw/opencode-telegram.git
Set-Location opencode-telegram
npm.cmd ci
Copy-Item .env.example .env
notepad .env
```

Use `npm.cmd` para evitar a política de execução de `npm.ps1`. Não desative globalmente a política de segurança do PowerShell. Não execute `npm ci` no checkout usado pela instalação WSL: a dependência SQLite possui binários específicos do sistema.

## 2. Configurar

Configure token, ID do proprietário e URL HTTPS em `.env`, como no [guia geral](installation.md). Troque o caminho Linux por uma pasta Windows existente e autorizada, usando barras normais:

```dotenv
OPENCODE_DIRECTORY=E:/Projetos/Meu projeto
OPENCODE_URL=http://127.0.0.1:4096
BRIDGE_HOST=127.0.0.1
BRIDGE_PORT=8787
BRIDGE_DATABASE_PATH=./data/bridge.sqlite
ALLOW_INSECURE_LOCAL_DEV=false
```

Não copie credenciais neste exemplo nem publique `.env`. Não use a raiz do disco como workspace. Provedores, agentes e MCPs configurados no OpenCode do WSL não aparecem automaticamente no OpenCode do Windows: configure a instalação nativa que o Bridge realmente consulta.

## 3. Executar

Na pasta do repositório:

```powershell
npm.cmd run build
```

No primeiro terminal, entre na pasta autorizada e execute:

```powershell
Set-Location 'E:\Projetos\Meu projeto'
opencode serve --hostname 127.0.0.1 --port 4096
```

No segundo terminal, entre no repositório e execute:

```powershell
npm.cmd start
```

Se configurou autenticação no servidor OpenCode, as credenciais correspondentes em `.env` devem coincidir. Configure o túnel HTTPS no Windows apontando somente para `http://localhost:8787`; não exponha 4096 ou 5173. Um conector Cloudflare instalado no WSL não é automaticamente um serviço do Windows.

Confira disponibilidade (não prova autenticação nem inferência):

```powershell
Invoke-RestMethod http://127.0.0.1:8787/api/v1/system/health
```

Configure o botão no BotFather, abra o Mini App, pareie o dispositivo e teste uma conversa. Guarde a chave de recuperação fora do Telegram.

## 4. Manter em execução

Inicialmente mantenha os dois terminais abertos. Para executar no login, use o Agendador de Tarefas do Windows com **duas tarefas separadas**, a mesma conta de usuário que configurou o OpenCode e diretórios de trabalho explícitos. A tarefa do Bridge pode executar `node.exe` com argumento `apps\bridge\dist\server.js`, iniciando na pasta do repositório. A tarefa do OpenCode deve executar o binário nativo com os argumentos `serve --hostname 127.0.0.1 --port 4096`, iniciando na pasta autorizada. Configure reinício em caso de falha. Não grave token ou senha nos argumentos das tarefas.

O túnel exige seu próprio processo/serviço. Suspensão, desligamento e perda de rede tornam a instalação indisponível. Não exponha portas no firewall como substituto do túnel.

## Diagnóstico e validação

- Falha em `better-sqlite3`: confirme Node 22+ x64 e faça instalação limpa em uma pasta exclusiva para Windows. Não copie módulos Linux. Se não houver binário pré-compilado compatível, o npm pode exigir as ferramentas de compilação C++ do Windows.
- `git` não encontrado: instale Git para Windows e reabra o terminal.
- Testes de links simbólicos podem exigir Modo de Desenvolvedor ou privilégios apropriados; não remova testes de segurança para obter um resultado verde.
- Erro 1033: confira o processo do conector do túnel; não é prova de erro do Mini App.
- Antes de atualizar, faça backup protegido de `.env` e do banco conforme [operação](operations.md).

```powershell
npm.cmd run check
npm.cmd test
npm.cmd run build
npm.cmd run test:runtime
```

O teste de execução cria e remove sua própria cópia descartável dos builds, ignora credenciais de produção e verifica banco/startup/HTTP local. Nunca o execute com um túnel apontando para a porta de teste. A validação nativa de dependências/testes não equivale a aprovação física de Telegram, suspensão do Windows ou inicialização no login. Registre esses resultados na matriz de aceitação, com sistema, versão do Telegram, dispositivo e resultados reais.
