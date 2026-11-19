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
BITACORA.md                   registro de cada sesión de trabajo
```

Las secciones de requisitos, ejecución, puertos y problemas conocidos se completan a medida que avanza el proyecto.

## Regenerar los diagramas

```
plantuml -tpng -charset UTF-8 docs/uml/*.puml
```
