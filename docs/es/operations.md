# Preparación para publicar y operación

## Alcance y evidencias

La instalación actual es un entorno WSL/Linux de un solo propietario, con servidor OpenCode externo y túnel Cloudflare. La compilación de la imagen Linux, la ejecución con sistema de archivos de solo lectura y la prueba aislada de disponibilidad fueron satisfactorias. Esto no demuestra compatibilidad con contenedores Windows/macOS ni operación autenticada en un contenedor. Reconexión, teclado y recuperación de dispositivos en Telegram Android/Desktop siguen requiriendo aceptación física; una respuesta HTTP de estado no valida una conversación autenticada.

La instalación Windows nativa se describe en [Windows nativo](windows-native.md). El 03/10/2026, una instalación aislada con Node 22.18 completó `npm ci`, sin hallazgos de auditoría, 101 pruebas del Bridge y 34 del Mini App, comprobación de tipos y compilación de producción. Esta evidencia histórica no valida Docker Desktop, autenticación física de Telegram, tareas de inicio de sesión ni inferencia de OpenCode en Windows. Posteriormente, el [CI del commit f0e1296](https://github.com/SanNw/opencode-telegram/actions/runs/37151119130) pasó en Linux y Windows nativo; el número de pruebas aumentó desde la comprobación inicial.

## Despliegue opcional en contenedor — solo Linux

El Dockerfile compila y prueba ambos componentes y se ejecuta con un usuario sin privilegios. Compose utiliza **la red del equipo anfitrión** porque el Bridge solo acepta conexiones en la interfaz de retorno local. No publica un puerto del equipo ni instala OpenCode/cloudflared. Esta red reduce el aislamiento; úsala solo en un equipo Linux de confianza y de un solo propietario. Docker Desktop/Windows/macOS no están validados para esta configuración.

1. Instala y configura OpenCode y cloudflared en el mismo equipo Linux. Mantén OpenCode autenticado y en la interfaz de retorno local.
2. Crea `.env` desde `.env.example`, configura las credenciales del propietario, URL/contraseña de OpenCode y la ruta absoluta `OPENCODE_DIRECTORY` usada por el servidor externo. Nunca añadas `.env` a Git.
3. Monta el espacio de trabajo **en la misma ruta absoluta**, en modo de solo lectura. Debe poder leerlo el UID 1000 del contenedor. No montes `/`, toda una carpeta personal, el socket de Docker ni carpetas amplias con datos sensibles. No uses `/app` ni su carpeta superior como espacio de trabajo; `/app` está reservado para la imagen.
4. Ejecuta `docker compose config --quiet` y después `docker compose build`. No muestres la configuración resuelta sin `--quiet`: contiene secretos.
5. Antes de sustituir un despliegue existente, realiza una copia de seguridad y detén el Bridge anterior para evitar conflictos de puertos. Compose utiliza un volumen de base de datos separado; no importa automáticamente la base ni los dispositivos anteriores.
6. Ejecuta `docker compose up -d`. Comprueba `docker compose ps` y prueba disponibilidad y una sesión autenticada de Telegram. Consulta los registros de inicio localmente para recuperar el código de vinculación.

El montaje de solo lectura limita el acceso del Bridge a los archivos, no la capacidad del OpenCode externo de editarlos. El volumen `bridge-data` se conserva tras `docker compose down`; no uses `down --volumes` salvo que quieras destruir explícitamente el estado almacenado.

## Copias de seguridad y restauración

Utiliza la API de copias en línea de SQLite o `sqlite3 DATABASE '.backup BACKUP'`, con rutas explícitas y validadas, destino único y permisos restringidos. **No copies únicamente el archivo `.sqlite` activo** mientras haya escrituras en el registro WAL. Comprueba `PRAGMA integrity_check` en la copia. Guarda la configuración protegida por separado y mantén ambos fuera de Git y de ubicaciones públicas.

En esta copia del repositorio, `node deploy/backup-bridge.mjs` utiliza la base configurada y reserva un destino único con fecha/hora en `data/backups`. Usa la API en línea de SQLite, restringe el archivo al modo 0600 y verifica su integridad. El argumento opcional de destino debe indicar una ubicación privada; nunca se sobrescriben archivos existentes. El programa no imprime configuración ni credenciales.

Restaura únicamente durante una parada planificada, con el Bridge detenido. Conserva la base actual y sus archivos WAL/SHM como un conjunto recuperable antes de sustituirlos. Comprueba integridad y compatibilidad del esquema con la versión elegida; restaura propietario y permisos antes de reiniciar. Nunca mezcles archivos WAL anteriores con una base restaurada. No reviertas el código sin comprobar una migración de esquema. Prueba la restauración en una instancia separada, sin túnel público, antes de depender de ella.

## Actualizaciones y desinstalación

Antes de actualizar: registra la versión, realiza copias, ejecuta comprobaciones/pruebas/compilación, revisa las migraciones y los hallazgos aceptados de dependencias; después reinicia y prueba autenticación, respuestas en tiempo real y adjuntos. Conserva la compilación anterior y la copia previa a la actualización para una recuperación controlada. El estado del servicio no demuestra inferencia del modelo.

Para desinstalar: detén el Bridge y su ruta dedicada del túnel; desactiva únicamente los servicios creados para este proyecto. Conserva datos y copias por defecto. No elimines OpenCode, espacios de trabajo, otras rutas Cloudflare ni credenciales compartidas.

## Límites de las funciones

La clave de recuperación, las sesiones reforzadas de cinco minutos y el bloqueo de emergencia están implementados en el Bridge. Guarda la clave fuera de Telegram y de esta instalación: se muestra una sola vez y la base conserva únicamente un verificador scrypt con sal. La recuperación crea un nuevo dispositivo de confianza y revoca los anteriores y sus sesiones; no omite la prueba del dispositivo. El bloqueo congela primero el acceso y después intenta detener OpenCode y rechazar permisos pendientes. Un fallo de esa interrupción se registra y no deshace el bloqueo.

El catálogo expone Skills, servidores MCP, plugins y proveedores normalizados, con datos sensibles eliminados. Conectar/eliminar claves de API requiere una acción reforzada y aprobada; la clave permanece en memoria cinco minutos y debe enviarse de nuevo tras reiniciar o caducar. La configuración de Skills/plugins es de solo lectura en el contrato probado. Los cambios MCP solo afectan a la ejecución, sin garantía de persistencia tras reiniciar. Añadir endpoints remotos requiere una entrada exacta en `MANAGEMENT_ALLOWED_HOSTS` y validación de HTTPS/DNS público; la lista vacía predeterminada impide añadirlos. Estos límites deben seguir visibles en el Mini App.

La galería de artefactos se limita a adjuntos autorizados de mensajes OpenCode con IDs opacos que caducan. No expone rutas arbitrarias ni trata los archivos cargados como artefactos generados. La vista previa HTML utiliza el aislamiento existente.

Commit, pull y push de Git requieren autenticación reforzada y aprobación. Los commits seleccionan rutas modificadas explícitas y rechazan cambios preparados ajenos. Pull permite únicamente avance directo, sin fusión. Push utiliza una única rama remota validada y rechaza configuraciones de espejo o envío personalizado. Aprobar una acción es decisión del usuario, no permiso para envíos automáticos.

Las pruebas de dimensiones y ciclo de vida son evidencias de la aplicación web. Teclado, suspensión y recuperación real de sesión firmada en Telegram Android/Desktop aún requieren la matriz física; simulaciones de tamaño o respuestas HTTP no las sustituyen.

## Criterios de distribución

- El CI debe pasar en un ejecutor Linux limpio, incluidas dependencias nativas y compilación de la imagen.
- Ejecuta el contenedor en una instalación desechable; verifica red local, propietario de la base persistente, disponibilidad, vinculación, respuestas y archivos antes de sustituir producción.
- Ejecuta la matriz real Telegram: pérdida de red, segundo plano/regreso, autenticación caducada, área obstruida por el teclado, dispositivo revocado y respuesta larga.
- Prueba reinicio del servicio/equipo y restauración de copias. Registra plataforma, versión y resultados, no suposiciones.
- Completa una revisión independiente de seguridad y documenta los hallazgos. La detección de secretos y protección de envíos de GitHub deben habilitarse por separado cuando estén disponibles.
- El propietario eligió MIT y el repositorio es público como beta. No impliques certificación formal ni plazo contractual de soporte.

## Pendientes y límites del alcance

| Elemento | Estado / evidencia necesaria |
| --- | --- |
| Dependencias, rutas, pruebas y compilación en Windows nativo | Validadas localmente y en el CI del commit f0e1296; no sustituye la prueba física. |
| Comportamiento real de Telegram Android/Desktop | Se requiere matriz física; los resultados simulados no la cierran. |
| Inicio de sesión, reinicio y reconexión del túnel en Windows | Requiere instalación nativa configurada y prueba real; producción WSL no se migró. |
| Restauración de una copia | Debe ejercitarse en una instancia desechable antes de depender de ella. |
| Revisión independiente de seguridad | Revisión externa pendiente, no una afirmación del implementador. |
| Traducciones | Seis idiomas; contenido externo o texto desconocido no se traduce automáticamente. |
| Edición de Skills/plugins y configuración MCP persistente | Requiere contrato de escritura compatible, validación y aprobación explícita. No edites configuración bruta para simular funciones no disponibles. |
| Propietario único / red local / lista exacta de hosts | Límites intencionales. Multiusuario o exposición de red requiere un modelo de amenazas separado. |
| Docker Desktop/macOS | No validado; las instrucciones Windows nativo no demuestran portabilidad del contenedor. |

No declares terminado el proyecto eliminando estas condiciones. Cada elemento dependiente de validación requiere evidencia fechada; las funciones dependientes de OpenCode necesitan un contrato probado.

El informe inicial de implementación es histórico, no una matriz actual de funciones. Consulta conjuntamente capacidades de ejecución, pruebas actuales y especificación normativa; las funciones no disponibles deben seguir explícitamente no disponibles.

[Instalación](installation.md) · [Seguridad](security.md)
