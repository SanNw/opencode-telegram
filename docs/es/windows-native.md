# Windows nativo — sin WSL

Esta configuración no utiliza Docker ni systemd. Ejecuta todo en PowerShell de Windows, con Node.js 22 LTS o superior y Git para Windows instalados. OpenCode documenta la instalación nativa mediante npm, Scoop y Chocolatey, aunque recomienda WSL para mayor compatibilidad: [documentación oficial](https://opencode.ai/docs/).

## 1. Preparación

Abre una nueva ventana de PowerShell después de instalar Node/Git y ejecuta:

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

Usa `npm.cmd` para evitar la política de ejecución de `npm.ps1`. No desactives globalmente la política de seguridad de PowerShell. No ejecutes `npm ci` en la copia del repositorio usada por WSL: la dependencia SQLite incluye binarios específicos del sistema.

## 2. Configuración

Configura el token, el ID del propietario y la URL HTTPS en `.env`, como indica la [guía general](installation.md). Sustituye la ruta Linux por una carpeta Windows existente y autorizada, con barras normales:

```dotenv
OPENCODE_DIRECTORY=E:/Proyectos/Mi-proyecto
OPENCODE_URL=http://127.0.0.1:4096
BRIDGE_HOST=127.0.0.1
BRIDGE_PORT=8787
BRIDGE_DATABASE_PATH=./data/bridge.sqlite
ALLOW_INSECURE_LOCAL_DEV=false
```

No incluyas credenciales reales en este ejemplo ni publiques `.env`. No autorices todo el disco. Los proveedores, agentes y servidores MCP de OpenCode en WSL no aparecen automáticamente en Windows: configura la instalación nativa que consulta el Bridge.

## 3. Ejecución

En la carpeta del repositorio:

```powershell
npm.cmd run build
```

En el primer terminal, abre la carpeta autorizada e inicia OpenCode:

```powershell
Set-Location 'E:\Proyectos\Mi-proyecto'
opencode serve --hostname 127.0.0.1 --port 4096
```

En el segundo terminal, abre la carpeta del repositorio e inicia el Bridge:

```powershell
npm.cmd start
```

Si el servidor OpenCode utiliza autenticación, las credenciales correspondientes de `.env` deben coincidir. Configura el túnel HTTPS en Windows para dirigir únicamente `http://localhost:8787`; no expongas los puertos 4096 ni 5173. Un conector Cloudflare instalado en WSL no es automáticamente un servicio de Windows.

Comprueba solo la disponibilidad; no demuestra autenticación ni inferencia:

```powershell
Invoke-RestMethod http://127.0.0.1:8787/api/v1/system/health
```

Configura el botón en BotFather, abre el Mini App, vincula el dispositivo y prueba una conversación. Guarda la clave de recuperación fuera de Telegram.

## 4. Mantenerlo en ejecución

Al principio, mantén ambos terminales abiertos. Para iniciar al acceder a Windows, utiliza el Programador de tareas con **dos tareas separadas**, la cuenta que configuró OpenCode y carpetas de trabajo explícitas. La tarea del Bridge puede ejecutar `node.exe` con el argumento `apps\bridge\dist\server.js`, desde la carpeta del repositorio. La de OpenCode debe ejecutar el binario nativo con `serve --hostname 127.0.0.1 --port 4096`, desde la carpeta autorizada. Configura el reinicio en caso de fallo. No incluyas tokens ni contraseñas en los argumentos.

El túnel necesita su propio proceso o servicio. La suspensión, el apagado y la pérdida de red dejan la instalación sin conexión. No expongas puertos del cortafuegos como sustituto del túnel.

## Diagnóstico y validación

- Fallo de `better-sqlite3`: confirma Node 22+ x64 e instala las dependencias en una carpeta exclusiva para Windows. No copies módulos Linux. Si no existe un binario precompilado compatible, npm puede requerir herramientas C++ de Windows.
- `git` no encontrado: instala Git para Windows y vuelve a abrir el terminal.
- Las pruebas de enlaces simbólicos pueden requerir el modo de desarrollador o privilegios adecuados; no elimines pruebas de seguridad para obtener un resultado satisfactorio.
- Error 1033: comprueba el proceso del conector del túnel; no demuestra un fallo del Mini App.
- Antes de actualizar, realiza copias protegidas de `.env` y de la base de datos según [Operación y copias de seguridad](operations.md).

```powershell
npm.cmd run check
npm.cmd test
npm.cmd run build
npm.cmd run test:runtime
```

La prueba de ejecución crea y elimina su propia copia desechable de las compilaciones, ignora credenciales de producción y comprueba la base de datos, el inicio y HTTP local. No dirijas un túnel a su puerto de prueba. Validar dependencias y pruebas nativas no equivale a aceptación física de Telegram, suspensión de Windows o inicio de sesión. Registra el sistema, la versión de Telegram, el dispositivo y los resultados reales.
