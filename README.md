# Mensajero WebRTC en dos nodos — Sistemas Distribuidos (UTP)

Proyecto individual de **Juan David Llano Henao** para la asignatura Sistemas Distribuidos (docente Felipe Gutiérrez Isaza, 2026-2).

Mensajero web con chat, videollamada, envío de archivos y videollamada grupal con pantalla compartida (RETO). Los navegadores se comunican por **WebRTC**; dos **nodos de señalización** (Python + aiohttp) corren en **contenedores de sistema Incus** creados con **Terraform** y **cloud-init**, primero en una máquina virtual local y después en **Azure** para usuarios reales.

## Estado

| Fase | Contenido | Estado |
|---|---|---|
| 1. Investigación | `docs/informe_investigacion.pdf`, diagramas en `docs/uml/` | Entregado |
| 2. Primer avance (22 nov) | Dos nodos reproducibles con Terraform, señalización y mensajes por consola | En curso |
| 3. Interfaz, medios y archivos | Chat, videollamada, archivos, RETO, despliegue en Azure | Pendiente |

## Estructura

```
docs/
  informe_investigacion.pdf   informe de investigación (bloques A–H)
  uml/                        fuentes PlantUML (.puml) y diagramas (.png)
servidor/
  servidor.py                 servidor de señalización (aiohttp): /ws, /federacion, /salud
  cliente_consola.py          cliente de prueba por consola
infra/
  main.tf, variables.tf ...   Terraform: red Incus, perfil y los dos nodos
  cloud-init/nodo.yaml.tftpl  instala Python + aiohttp y crea el servicio systemd
scripts/
  probar_avance.sh            demostración del primer avance (DNS, servicio, mensajes, logs)
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

En cada cliente se escribe `destino: texto` (por ejemplo `ana: hola`), `/usuarios` o `/salir`. Para ver los logs en vivo:

```
incus exec nodo1 -- journalctl -u mensajero -f
```

Para actualizar el código de un nodo: `terraform apply -replace='incus_instance.nodo["nodo1"]'`. Para borrar todo: `terraform destroy`.

## Puertos

| Puerto | Dónde | Uso |
|---|---|---|
| 8080/tcp | nodo1 y nodo2 (red interna `redmsg`) | HTTP, WebSocket de clientes (`/ws`) y de federación (`/federacion`) |
| 443/tcp, 3478/udp | pasarela (fase 3) | HTTPS/WSS y STUN/TURN |

## Problemas conocidos

- cloud-init tarda 1 a 3 minutos la primera vez (descarga de paquetes); `probar_avance.sh` espera a que termine.
- Si ambos nodos arrancan al mismo tiempo pueden abrirse dos enlaces de federación (uno en cada sentido); el servidor envía cada mensaje por uno solo, así que no hay duplicados.

## Regenerar los diagramas

```
plantuml -tpng -charset UTF-8 docs/uml/*.puml
```
