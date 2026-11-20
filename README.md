# Mensajero WebRTC en dos nodos — Sistemas Distribuidos (UTP)

Proyecto individual de **Juan David Llano Henao** para la asignatura Sistemas Distribuidos (docente Felipe Gutiérrez Isaza, 2026-2).

Mensajero web con chat, videollamada, envío de archivos y videollamada grupal con pantalla compartida (RETO). Los navegadores se comunican por **WebRTC**; dos **nodos de señalización** (Python + aiohttp) corren en **contenedores de sistema Incus** creados con **Terraform** y **cloud-init**, primero en una máquina virtual local y después en **Azure** para usuarios reales.

## Estado

| Fase | Contenido | Estado |
|---|---|---|
| 1. Investigación | `docs/informe_investigacion.pdf`, diagramas en `docs/uml/` | Entregado |
| 2. Primer avance (22 nov) | Dos nodos reproducibles con Terraform, señalización y mensajes por consola | Hecho |
| 3. Interfaz, medios y archivos | Interfaz web, chat, videollamada, archivos con progreso y SHA-256, pasarela HTTPS | Hecho (local) |
| 4. RETO | Salas de videollamada en malla (4+), pantalla compartida, chat de sala, entrada con balanceo | Hecho (local) |
| 5. Nube | Despliegue en Azure con TURN propio | Pendiente |

## Estructura

```
docs/
  informe_investigacion.pdf   informe de investigación (bloques A–H)
  uml/                        fuentes PlantUML (.puml) y diagramas (.png)
servidor/
  servidor.py                 servidor de señalización (aiohttp): /ws, /federacion, /salud
  cliente_consola.py          cliente de prueba por consola
  web/                        interfaz web (index.html, estilos.css, app.js)
infra/
  main.tf, variables.tf ...   Terraform: red Incus, perfil y los dos nodos
  cloud-init/nodo.yaml.tftpl  instala Python + aiohttp, copia servidor e interfaz y crea el servicio systemd
  cloud-init/pasarela.yaml.tftpl  Caddy: proxy HTTPS hacia nodo1.incus y nodo2.incus
scripts/
  probar_avance.sh            demostración del primer avance (DNS, servicio, mensajes, logs)
  actualizar_nodos.sh         copia servidor e interfaz a los nodos sin recrearlos
BITACORA.md                   registro de cada sesión de trabajo
```

## Requisitos (primer avance)

- Anfitrión Linux con **Incus** (probado en Ubuntu Server 24.04 dentro de VirtualBox: 2 vCPU, 4 GB RAM).
- **Terraform** ≥ 1.6 (proveedor `lxc/incus` ~> 1.2).
- Salida a Internet desde el anfitrión (los nodos descargan la imagen y `python3-aiohttp`).

## Ejecutar el primer avance

En el anfitrión de Incus, con el repositorio clonado:

```
cd infra
terraform init
terraform apply              # crea la red redmsg, el perfil y los contenedores nodo1 y nodo2
cd ..
./scripts/probar_avance.sh   # espera a cloud-init y demuestra la comunicación entre nodos
```

Prueba manual desde la consola (dos terminales):

```
incus exec nodo1 -- python3 /opt/mensajero/cliente_consola.py ws://localhost:8080/ws ana
incus exec nodo2 -- python3 /opt/mensajero/cliente_consola.py ws://localhost:8080/ws beto
```

En cada cliente: `/con beto` fija el destinatario y luego se escribe normal; también sirve `beto: hola` para un mensaje puntual, `*: hola` para todos, `/usuarios` y `/salir`. Para ver los logs en vivo:

```
incus exec nodo1 -- journalctl -u mensajero -f
```

Para actualizar el código de un nodo: `terraform apply -replace='incus_instance.nodo["nodo1"]'`. Para borrar todo: `terraform destroy`.

## Usar el mensajero (interfaz web)

Después de `terraform apply` (crea también la instancia `pasarela` con Caddy), desde el navegador del equipo anfitrión:

1. Abrir `https://192.168.56.20/`. La pasarela asigna automáticamente un nodo (balanceo con cookie: la página y el WebSocket quedan en el mismo nodo; si un nodo cae, los nuevos usuarios van al otro). Para forzar un nodo en las demos: `/nodo1/` o `/nodo2/`. La primera vez el navegador advierte que el certificado no es de confianza (lo firma la CA interna de Caddy): **Configuración avanzada → Continuar**. HTTPS es obligatorio para usar cámara y micrófono.
2. Escribir un nombre (se recuerda en el navegador). Para probar entre nodos: una ventana por `/nodo1/` y otra (incógnito u otro navegador) por `/nodo2/`.
3. Clic en un contacto para chatear. Botón de cámara: videollamada (el otro contesta o rechaza); durante la llamada se puede silenciar, apagar la cámara y colgar.
4. Clip: enviar archivos de cualquier tipo y tamaño (probado con 21 MB y 40 MB). Barra de progreso en ambos lados; el receptor verifica SHA-256 y puede ver imágenes, reproducir audio y video o descargar.

5. **Salas (RETO):** «+ Sala» crea o une a una sala. Cada participante abre una conexión con cada uno de los demás (malla: 4 personas = 6 conexiones). La cuadrícula se reorganiza al entrar o salir; el bitrate de video se limita según el número de participantes (1 Mbit/s, 600 kbit/s o 350 kbit/s por emisor). «Compartir pantalla» reemplaza la cámara con `replaceTrack()` (sin renegociar); el servidor permite un solo presentador por sala y su video se muestra grande. La sala tiene su propio chat. Las salas viven en memoria y se replican entre los dos nodos por la federación (no se requiere base de datos).

Errores que se muestran al usuario: permiso de cámara negado, contacto desconectado (termina la llamada), archivo interrumpido, sin respuesta a la llamada, pérdida de conexión con el servidor (reintenta cada 3 s).

Opcional, para evitar la advertencia del certificado: `incus file pull pasarela/var/lib/caddy/.local/share/caddy/pki/authorities/local/root.crt .` e importar `root.crt` en Windows como entidad de certificación raíz de confianza.

## Puertos

| Puerto | Dónde | Uso |
|---|---|---|
| 8080/tcp | nodo1 y nodo2 (red interna `redmsg`) | HTTP, WebSocket de clientes (`/ws`) y de federación (`/federacion`) |
| 443/tcp y 80/tcp | anfitrión → pasarela (dispositivo proxy de Incus) | HTTPS/WSS (Caddy); 80 redirige a 443 |
| 3478/udp | STUN público (local) / coturn (nube, pendiente) | Descubrimiento de candidatos ICE |
| UDP efímeros | entre navegadores | WebRTC: SRTP (medios) y SCTP/DTLS (datos) |

## Seguridad

- Chat 1:1 cifrado de extremo a extremo: ECDH P-256 + HKDF-SHA-256 → AES-256-GCM (WebCrypto). El servidor solo reenvía texto cifrado. Botón del candado: código de seguridad de 60 cifras para comparar con el contacto.
- Video, audio y archivos: cifrados por WebRTC (DTLS-SRTP y DTLS/SCTP), van directo entre navegadores.
- Limitación: el chat de las salas pasa por el servidor sin cifrado E2E (solo TLS hasta la pasarela).

## Problemas conocidos

- cloud-init tarda 1 a 3 minutos la primera vez (descarga de paquetes); `probar_avance.sh` espera a que termine.
- Si se corta el WebSocket de señalización, el cliente se reconecta solo a su mismo nodo (con una clave de sesión por pestaña) y vuelve a entrar a la sala; las conexiones P2P de video no se cortan.
- Si ambos nodos arrancan al mismo tiempo pueden abrirse dos enlaces de federación (uno en cada sentido); el servidor envía cada mensaje por uno solo, así que no hay duplicados.

## Regenerar los diagramas

```
plantuml -tpng -charset UTF-8 docs/uml/*.puml
```
