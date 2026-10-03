# Política de seguridad

Este proyecto es una interfaz remota de un solo propietario para una instalación OpenCode. No es un servicio multiusuario ni ha recibido una certificación independiente de seguridad.

## Límites de confianza

- Mantén el Bridge y OpenCode en la interfaz de retorno local. Solo el Bridge autenticado debe dirigirse mediante el túnel HTTPS; nunca publiques OpenCode directamente.
- La inicialización firmada de Telegram, la autorización del propietario y la prueba del dispositivo de confianza protegen el acceso. Protege el código local de vinculación como una credencial; puede aparecer en los registros del servicio.
- La aprobación del Bridge no sustituye los permisos de herramientas de OpenCode. Un mensaje puede desencadenar el uso posterior de herramientas. Configura permisos adecuados al espacio de trabajo.
- Las referencias de archivos son IDs opacos vinculados al propietario. La carpeta configurada es un límite impuesto por el servidor, no una ruta elegida por el navegador.
- La vista previa HTML es deliberadamente estática y aislada. No añadas privilegios de scripts ni de mismo origen al marco de vista previa.
- Las copias SQLite contienen datos sensibles de autenticación, metadatos y posiblemente contenido cargado. Cífralas y restringe su acceso.
- La configuración de la clave de recuperación muestra una clave de 256 bits una sola vez. Guárdala fuera de Telegram y de este equipo; solo se conserva un verificador scrypt con sal. La autenticación reforzada concede cinco minutos de privilegios vinculados al usuario, dispositivo y sesión actuales, no una credencial de acceso sin restricciones.
- Los cambios de integraciones/proveedores y Git requieren autenticación reforzada y aprobación explícita. Las claves de proveedores permanecen en un búfer temporal del servidor, de un solo uso, nunca en la base de propuestas ni en su resumen. Los endpoints remotos se deniegan por defecto, salvo autorización explícita en la lista de hosts.

## Informar de vulnerabilidades

No publiques tokens, códigos de vinculación, datos firmados de Telegram, cookies, bases de datos ni contenido privado en una incidencia pública. Envía una reproducción mínima en privado al mantenedor mediante un canal ya establecido. Si el repositorio permite informes privados de vulnerabilidades, usa la sección de seguridad de GitHub. No se declara un buzón público de seguridad supervisado ni un plazo de respuesta.

## Contención inmediata

1. Con un dispositivo de confianza y la clave de recuperación guardada, usa Seguridad → Bloquear acceso remoto o marca la cuenta Telegram como comprometida. Esto revoca sesiones y congela acciones pendientes antes de intentar detener o rechazar acciones en OpenCode. Si el Mini App no está disponible, detén localmente `opencode-telegram-bridge.service` o el servicio Bridge de Compose; detén el túnel si no puedes aislar sus rutas con seguridad.
2. Revoca en BotFather el token del bot si se ha expuesto. Cambia las credenciales de OpenCode afectadas. Actualiza la configuración local protegida antes de reiniciar.
3. Conserva copias restringidas de los registros y del estado de la base de datos necesarios para el diagnóstico. No las publiques.
4. Desde un entorno de confianza, revoca los dispositivos afectados y revisa los cambios de OpenCode y las aprobaciones pendientes antes de restaurar el acceso remoto.

Si no queda un dispositivo de confianza, pero tienes la clave de recuperación, utiliza el formulario de recuperación independiente. Demuestra la posesión de una nueva clave P-256 del dispositivo, revoca dispositivos y sesiones anteriores y restaura el acceso sin confiar en la inicialización de Telegram. Si no tienes la clave, mantén detenido el acceso remoto y realiza la recuperación administrativa local. No elimines la base de datos ni omitas automáticamente la autenticación. Un fallo al detener OpenCode no implica un fallo del bloqueo; revisa la auditoría antes de reanudar el trabajo.

## Criterios de publicación

Exige pruebas aprobadas, revisión de dependencias y ausencia de secretos expuestos antes de distribuir. La auditoría de dependencias de la integración continua no es una prueba de penetración. Activa la detección de secretos y la protección de envíos del repositorio cuando estén disponibles; son ajustes de GitHub, no se activan mediante este documento. Documenta los hallazgos aceptados en lugar de desactivar la auditoría globalmente.

[Instalación](installation.md) · [Operación y copias de seguridad](operations.md)
