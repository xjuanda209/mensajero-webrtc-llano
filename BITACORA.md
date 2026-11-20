# Bitácora — Mensajero WebRTC

Una entrada por sesión de trabajo: fecha, tiempo dedicado, qué se hizo, problemas y soluciones, y uso de IA.

---

## Sesión 1 — 19 de noviembre de 2026

**Tiempo dedicado:** 3h

**Qué se hizo**
- Lectura de la guía del laboratorio y planeación del cronograma.
- Decisión de plataforma: contenedores de sistema Incus aprovisionados con Terraform y cloud-init (sugerencia del docente como opción más completa), con despliegue final en Azure for Students para usuarios reales.
- Decisión de hacer el RETO (videollamada grupal en malla y pantalla compartida).
- Investigación de los bloques A a H con fuentes primarias (RFC del IETF, especificaciones W3C, documentación de Incus, Terraform, MDN).
- Verificación práctica del proveedor de Terraform `lxc/incus` (v1.2.1): se ejecutó `terraform init` y `terraform providers schema` para confirmar los nombres reales de los recursos (`incus_network`, `incus_profile`, `incus_instance`, `incus_network_forward`).
- Diagramas UML en PlantUML: componentes, despliegue, secuencia de llamada, secuencia de archivo, estados de conexión, entrada a sala (RETO) y bosquejo de la interfaz.
- Redacción del informe de investigación (`docs/informe_investigacion.pdf`).

**Problemas y soluciones**
- La fase de investigación oficial era del 12 al 17 de noviembre y se inició tarde → se concentró la investigación en una sesión y se priorizó subir el informe antes de cualquier código, como exige la guía.
- Incus solo funciona en Linux y el equipo es Windows → se usará una máquina virtual Ubuntu Server 24.04 en VirtualBox como anfitrión de Incus.
- La cámara no funciona por HTTP en una IP que no sea localhost → se incluyó Caddy con HTTPS desde el diseño.

**Uso de IA**
- Se usó un asistente de IA (Claude) para organizar el plan de trabajo, buscar y verificar fuentes, generar borradores de las respuestas del informe y de los diagramas PlantUML. Todo el contenido fue revisado y las decisiones de arquitectura son propias.

---

## Sesión 2 — 19 de noviembre de 2026 (código del primer avance)

**Tiempo dedicado:** 5 h

**Qué se hizo**
- Servidor de señalización `servidor/servidor.py` (Python + aiohttp): WebSocket de clientes (`/ws`), enlace entre nodos (`/federacion`), estado (`/salud`). Registro de usuarios, presencia, chat y reenvío de mensajes dirigidos (`oferta`, `respuesta`, `candidato`) al otro nodo.
- Cliente de consola `servidor/cliente_consola.py` para probar sin interfaz.
- Infraestructura en `infra/` con Terraform (proveedor `lxc/incus`): red `redmsg` con DNS `.incus`, perfil con límites (1 CPU, 512 MiB) y los contenedores `nodo1` y `nodo2`. cloud-init instala `python3-aiohttp`, copia el código y crea el servicio systemd `mensajero`.
- Script `scripts/probar_avance.sh` para la demostración: DNS, servicio, `/salud`, mensaje entre nodos y logs.
- Prueba local con dos procesos (puertos 18081 y 18082): mensajes en ambos sentidos, difusión a todos, presencia y error de destinatario inexistente.
- `terraform validate` correcto.

**Problemas y soluciones**
- Si ambos nodos se conectan a la vez se abren dos enlaces de federación → el servidor envía cada mensaje por un solo enlace para no duplicar.
- El cliente de consola sin teclado (en el script) entraba en un ciclo al leer fin de archivo → ahora, al detectar EOF, solo escucha.

**Uso de IA**
- Se usó Claude para generar un primer borrador del servidor, del cliente de consola y de los archivos de Terraform; el código se revisó, se probó y se ajustó.

**Ajuste tras la primera prueba en Incus (19 nov):** el formato `destino: texto` resultó incómodo y un usuario podía enviarse mensajes a sí mismo. Se agregó el comando `/con <usuario>` al cliente de consola y el servidor ahora rechaza mensajes dirigidos al mismo remitente.

---

## Sesión 3 — 19 de noviembre de 2026 (fase 3: interfaz, medios y archivos)

**Tiempo dedicado:** 4h

**Qué se hizo**
- Interfaz web (`servidor/web/`): ingreso con nombre, directorio con presencia y nodo de cada usuario, chat, videollamada con contestar/rechazar, silenciar micrófono, apagar cámara y colgar.
- Conexión entre pares con el patrón *perfect negotiation* (rol polite/impolite según el nombre) y un `RTCDataChannel` negociado (id 0) por contacto.
- Archivos de cualquier tipo por fragmentos de 16 KiB con control de flujo (`bufferedAmount` > 1 MiB → esperar `bufferedamountlow`), barra de progreso y verificación SHA-256 en el receptor; vista previa de imagen, audio y video.
- Manejo de errores visible: permiso de cámara negado, contacto desconectado, archivo interrumpido, llamada sin respuesta, ocupado, pérdida del servidor.
- Servidor: nuevos tipos dirigidos (`llamada`, `aceptar`, `rechazar`, `colgar`, `ocupado`) y `/config` con los servidores ICE.
- Terraform: instancia `pasarela` con Caddy (HTTPS con CA interna) publicada con dispositivos proxy de Incus en los puertos 443 y 80; los nodos reciben la interfaz por cloud-init.
- Pruebas automáticas en navegador (Playwright con cámara simulada) entre un usuario en nodo1 y otro en nodo2: chat, imagen, archivo de 21 MB íntegro, videollamada conectada P2P, colgar, archivo de 40 MB interrumpido, desconexión durante la llamada y permiso negado. También a través de Caddy por HTTPS.

**Problemas y soluciones**
- El indicador de la llamada se quedaba en «Conectando…» porque la conexión ya estaba establecida por el canal de datos → se actualiza el texto según `connectionState` al iniciar la llamada.
- El mensaje de archivo interrumpido mostraba el error técnico del navegador → se cambió por «el otro extremo cerró la conexión».

**Uso de IA**
- Claude generó el primer borrador de la interfaz y de la lógica WebRTC; se revisó y se probó con pruebas automáticas.
