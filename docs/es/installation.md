# Instalación en Linux / WSL

Para instalar sin WSL, sigue [Windows nativo (PowerShell)](windows-native.md). No compartas `node_modules` entre sistemas operativos.

## Preparación

Instala Node.js 22+, Git y OpenCode. Ejecuta OpenCode y el Bridge en el mismo entorno Linux/WSL. La interfaz puede abrirse desde Telegram en otros sistemas, pero esto no significa que todos los equipos de instalación estén validados.

```bash
git clone https://github.com/SanNw/opencode-telegram.git
cd opencode-telegram
npm ci
cp .env.example .env
```

| Variable | Valor |
| --- | --- |
| `TELEGRAM_BOT_TOKEN` | Token creado en BotFather; mantenlo privado |
| `TELEGRAM_OWNER_ID` | ID numérico del propietario |
| `TELEGRAM_MINI_APP_URL` | URL pública HTTPS del Mini App |
| `OPENCODE_DIRECTORY` | Ruta absoluta de una carpeta de proyecto autorizada, no de todo el disco |
| `OPENCODE_URL` | Servidor local; valor predeterminado: `http://127.0.0.1:4096` |
| `OPENCODE_SERVER_USERNAME` / `OPENCODE_SERVER_PASSWORD` | Credenciales correspondientes de OpenCode, si están configuradas |

No actives `ALLOW_INSECURE_LOCAL_DEV` en instalaciones expuestas mediante un túnel. No compartas `.env`, bases de datos, copias de seguridad, cookies ni códigos de vinculación.

## Ejecución

Ejecuta `npm run build`. En un terminal, ejecuta `opencode serve --hostname 127.0.0.1 --port 4096`; en otro, ejecuta `npm start` desde la carpeta del repositorio. El Bridge sirve la API y el Mini App en el puerto 8787.

Para comprobar solo la disponibilidad: `curl http://127.0.0.1:8787/api/v1/system/health`. La respuesta de estado no demuestra autenticación ni inferencia del modelo.

## HTTPS y Telegram

Configura un túnel o proxy inverso HTTPS que dirija **únicamente** `http://localhost:8787`. No expongas OpenCode en el puerto 4096 ni Vite en el 5173. El dominio y el túnel deben pertenecer a tu instalación.

En BotFather, configura el botón de menú con la URL HTTPS del Mini App. Ábrelo desde el botón e introduce el código mostrado en el terminal del Bridge. Después de vincular el dispositivo, prueba un mensaje y su aprobación.

## Protección y mantenimiento

Configura la clave de recuperación en Seguridad y guárdala fuera de Telegram. Configura los permisos de OpenCode: la aprobación del Bridge no sustituye los permisos de las herramientas del agente.

Para un servicio persistente, adapta las rutas y el usuario de los ejemplos en `deploy/systemd/`; no se instalan automáticamente. Haz una copia de seguridad antes de actualizar. Consulta [Operación y copias de seguridad](operations.md) y [Seguridad](security.md).
