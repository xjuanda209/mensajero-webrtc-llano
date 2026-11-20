# Bitácora — Mensajero WebRTC

Una entrada por sesión de trabajo: fecha, tiempo dedicado, qué se hizo, problemas y soluciones, y uso de IA.

---

## Sesión 1 — 19 de noviembre de 2026

**Tiempo dedicado:** _(completar)_ h

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

**Tiempo dedicado:** _(completar)_ h

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

**Tiempo dedicado:** _(completar)_ h

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

**Ajuste (20 nov):** al abrir `https://192.168.56.20` el navegador mostraba `ERR_SSL_PROTOCOL_ERROR`. Causa: al entrar por IP el navegador no envía SNI y el dispositivo proxy de Incus entrega la conexión a Caddy por 127.0.0.1, así que Caddy no sabía qué certificado presentar. Solución: opción global `default_sni` en el Caddyfile (se reprodujo y verificó el error y la corrección con Caddy 2.6.2).

---

## Sesión 4 — 20 de noviembre de 2026 (RETO y mejora de la entrada)

**Tiempo dedicado:** _(completar)_ h

**Qué se hizo**
- RETO, salas en el servidor: `unirse`, `salir`, `miembros`, `entro`, `salio`, `salas`, chat de sala y control de pantalla compartida (un presentador por sala). El estado de las salas se replica entre nodo1 y nodo2 con eventos `sala_evento` por la federación, de modo que una sala puede tener participantes en ambos nodos.
- RETO, cliente: videollamada grupal en malla (una `RTCPeerConnection` por par, perfect negotiation), cuadrícula que se reorganiza, límite de bitrate según participantes con `RTCRtpSender.setParameters`, pantalla compartida con `getDisplayMedia` + `replaceTrack` y manejo del evento `ended`.
- Entrada: pantalla de bienvenida sin elegir nodo; Caddy balancea la raíz entre los dos nodos con `lb_policy cookie` (luego cambiado a `least_conn`, ver ajuste) y conmuta si un nodo falla. Las rutas `/nodo1/` y `/nodo2/` se conservan para demostraciones.
- Prueba automática con 4 navegadores (2 en cada nodo): los 4 ven 3 videos remotos (6 conexiones), chat de sala, pantalla compartida visible para todos, segundo presentador rechazado, salidas dinámicas.

**Decisiones**
- No se usa base de datos: la guía no pide login ni historial; las salas y usuarios son estado en memoria replicado entre nodos. Se documenta como limitación.
- Cambio frente a la arquitectura inicial: la portada para elegir nodo se reemplazó por balanceo en la pasarela.

**Uso de IA**
- Claude propuso y escribió el primer borrador de las salas y la llamada grupal; se verificó con pruebas automáticas de 4 participantes.

**Ajuste del balanceo (20 nov):** con `lb_policy cookie` todas las pestañas de un mismo navegador compartían la cookie y caían en el mismo nodo, así que en la demo parecía que no balanceaba. Se cambió a `lb_policy least_conn`: cada WebSocket abierto cuenta como conexión activa y cada usuario nuevo va al nodo con menos usuarios. El cliente toma el nombre del nodo del mensaje `bienvenida` (el nodo real que atiende su WebSocket). Prueba: 6 pestañas del mismo navegador quedaron repartidas 3 en nodo1 y 3 en nodo2.

**Ajuste de reconexión (20 nov):** en la prueba real con 4 personas, a un participante le apareció "Se perdió la conexión con el servidor de señalización" y la sala quedó mostrando 3. Causa: al caerse el WebSocket el servidor lo sacaba de la sala y, al reintentar, el balanceo podía mandarlo al otro nodo o el nombre seguía "en uso" por la sesión vieja. Solución: (1) cada pestaña genera una clave de sesión y la envía en `registro`; si llega la misma clave para un nombre ya conectado, el servidor reemplaza la conexión vieja sin sacarlo de la sala (log `RECONEXION`); (2) el cliente reintenta cada 2 s contra **su mismo nodo** (`/nodoX/ws`) y, si falla 3 veces, vuelve a la entrada balanceada; (3) al recibir `bienvenida` reenvía `unirse` a la sala en la que estaba. Prueba: 4 navegadores repartidos 2/2 en la sala, se cortó el WebSocket de dos participantes (uno en cada nodo): ambos volvieron solos, los 4 siguieron viendo 3 videos y el chat de sala funcionó. También se comprobó que otra pestaña con el mismo nombre pero sin la clave sigue siendo rechazada.

**Ajuste de robustez (20 nov, prueba con 4 personas):** se observaron tres fallas intermitentes y se corrigieron:
1. *Un participante queda solo en la sala mientras los demás siguen ahí; mensajes que llegan tarde.* Causa: se cortaba un momento el enlace de federación nodo1↔nodo2 (VM con poca CPU) y cada nodo sacaba de inmediato a todos los usuarios del otro nodo de las salas; al volver el enlace la sala se re-sincronizaba en el servidor pero los clientes no se enteraban. Solución: periodo de gracia de 20 s antes de dar por perdidos a los remotos, cola de mensajes durante el corte que se reenvía al volver, conciliación al recibir `hola_nodo` (avisa `entro`/`salio` solo de lo que realmente cambió) y heartbeat de federación de 30 s. En el cliente, `conciliarSala()` compara la sala local con la lista del servidor y agrega, quita o vuelve a entrar si no coinciden. Prueba con un proxy entre nodos que se apaga: corte de 6 s → nadie sale de la sala y el mensaje enviado durante el corte llega; corte de 30 s → los remotos se retiran y al volver el enlace la sala se reconstruye sola con los 4 videos.
2. *Video congelado entre dos participantes al entrar varios a la vez.* Causa: en el choque de ofertas (glare) a veces se perdían los candidatos ICE y la conexión quedaba en estado `new`. Solución: vigilante por par que, si a los 6 s no está `connected`, hace `restartIce()` (solo el lado impolite), y reinicio ICE automático en `disconnected`/`failed`.
3. *Caída del WebSocket de un usuario* (ya corregido con la clave de sesión).

---

## Sesión 5 — 20 de noviembre de 2026 (fase 4: cifrado, interfaz y robustez)

**Tiempo dedicado:** _(completar)_ h

**Qué se hizo**
- *Chat cifrado de extremo a extremo (1:1).* Cada pestaña genera un par de claves ECDH P-256 con WebCrypto (la privada no es exportable). Las claves públicas se intercambian con el mensaje `clave` a través del servidor; cada lado deriva la misma clave AES-256-GCM con ECDH + HKDF-SHA-256. Los mensajes viajan como `{cifrado, iv}` con datos adicionales `emisor>receptor`, y el servidor solo registra `[cifrado E2E, N car.]`. Código de seguridad de 12 grupos de 5 cifras (SHA-256 de ambas claves públicas) para detectar un intermediario; se puede marcar como verificado y avisa si la clave del contacto cambia. Si el otro extremo no soporta cifrado (cliente de consola), se envía en claro y se avisa. El chat de sala sigue pasando por el servidor sin cifrado E2E (limitación documentada); medios y archivos ya van cifrados por DTLS-SRTP / DTLS.
- *Llamada de voz:* botón de teléfono, solo audio, vista con avatar y cronómetro.
- *Archivos:* miniatura de imágenes con visor a pantalla completa, vista previa de PDF, reproductor de video/audio, ficha con tipo y tamaño, botón de guardar, envío de varios archivos a la vez y botón «Reintentar» si un envío falla (antes se quedaba en "Esperando confirmación").
- *Bienvenida:* portada con las cuatro funciones principales y formulario de entrada.
- *Ventana aparte para la cámara:* botón «Ventana aparte» en la llamada y en la sala. Con la API Document Picture-in-Picture (Chrome y Edge) la videollamada se mueve a una ventana flotante que queda encima de otras aplicaciones, con sus controles; en la página queda «Traer de vuelta». En otros navegadores se usa el Picture-in-Picture estándar del video.

**Errores encontrados en pruebas con 4 personas y cómo se corrigieron**
- *Cerrar la ventana sin "Salir de la sala" dejaba a los demás trabados.* Ahora `pagehide` avisa al servidor, cierra las RTCPeerConnection y el WebSocket; además, al recibir la presencia "desconectado" se saca al usuario de la sala aunque se pierda el aviso `salio`.
- *Videos en negro de todos:* si la cámara se cae (otra ventana del mismo PC la libera o el controlador se reinicia) se vuelve a pedir y se reemplaza la pista con `replaceTrack` en todas las conexiones.
- *Video congelado entre dos personas tras salir y volver a entrar:* se diagnosticó con `getStats()` que una conexión quedaba en `new` sin candidatos ICE locales. Recuperación en dos pasos: `restartIce()` y, si no basta, se rehace la RTCPeerConnection (la oferta va con `nueva:true` para que el otro lado también la rehaga). En 6 repeticiones del escenario salir/cerrar/volver, una se congeló y se recuperó sola.

**Uso de IA**
- Claude escribió el cifrado, la interfaz nueva y las correcciones; se verificaron con pruebas automáticas (Playwright) y en el log del servidor se comprobó que el texto del chat ya no es legible.
