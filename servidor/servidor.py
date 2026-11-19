#!/usr/bin/env python3
"""
Servidor de señalización del Mensajero WebRTC (un proceso por nodo).

- /ws          WebSocket de los clientes (navegador o consola).
- /federacion  WebSocket entre nodos: cada nodo se conecta a su par por nombre
               (NODO_PAR=ws://nodo2.incus:8080/federacion) y le reenvía los
               mensajes de usuarios que están conectados en el otro nodo.
- /salud       Estado del nodo en JSON (usuarios locales, remotos, enlace).
- /            Interfaz web (archivos de la carpeta web/).

Todos los mensajes son JSON con el sobre:
  {"tipo", "id", "de", "para", "sala", "nodo", "ts", "datos"}

Variables de entorno:
  NODO_NOMBRE  nombre de este nodo (por defecto el hostname)
  NODO_PAR     URL WebSocket de la federación del otro nodo
  PUERTO       puerto HTTP/WS (por defecto 8080)
"""
import asyncio
import json
import logging
import os
import socket
import time
import uuid
from pathlib import Path

from aiohttp import WSMsgType, web, ClientSession, ClientError

NODO = os.environ.get("NODO_NOMBRE", socket.gethostname())
PAR = os.environ.get("NODO_PAR", "")
PUERTO = int(os.environ.get("PUERTO", "8080"))
WEB = Path(__file__).with_name("web")

# Tipos que se enrutan a un destinatario (señalización WebRTC y chat).
DIRIGIDOS = {"chat", "oferta", "respuesta", "candidato", "colgar", "pantalla"}

logging.basicConfig(level=logging.INFO, format=f"%(asctime)s [{NODO}] %(message)s", datefmt="%H:%M:%S")
log = logging.getLogger("mensajero")

locales: dict[str, web.WebSocketResponse] = {}   # usuario -> WebSocket del cliente en ESTE nodo
remotos: dict[str, str] = {}                      # usuario -> nombre del nodo donde está
enlaces: set = set()                              # WebSockets abiertos hacia/desde el otro nodo


def sobre(tipo, de=None, para=None, datos=None, sala=None):
    return {"tipo": tipo, "id": uuid.uuid4().hex[:12], "de": de, "para": para,
            "sala": sala, "nodo": NODO, "ts": int(time.time()), "datos": datos or {}}


def directorio():
    usuarios = [{"usuario": u, "nodo": NODO} for u in sorted(locales)]
    usuarios += [{"usuario": u, "nodo": n} for u, n in sorted(remotos.items()) if u not in locales]
    return usuarios


async def enviar_ws(ws, msg):
    try:
        await ws.send_json(msg)
        return True
    except (ConnectionResetError, RuntimeError):
        return False


async def enviar_a_par(msg):
    """Envía un mensaje al otro nodo por cualquier enlace de federación abierto."""
    for ws in list(enlaces):
        if not ws.closed and await enviar_ws(ws, msg):
            return True
    return False


async def avisar_locales(msg, excepto=None):
    for usuario, ws in list(locales.items()):
        if usuario != excepto:
            await enviar_ws(ws, msg)


async def entregar(msg, desde_par=False):
    """Entrega un mensaje dirigido: a un usuario local, al otro nodo o a todos ('*')."""
    para = msg.get("para")
    if para == "*":
        await avisar_locales(msg, excepto=msg.get("de"))
        if not desde_par:
            await enviar_a_par({**sobre("reenvio"), "mensaje": msg})
        return True
    if para in locales:
        ok = await enviar_ws(locales[para], msg)
        log.info("ENTREGA  %-9s %s -> %s (local)", msg["tipo"], msg.get("de"), para)
        return ok
    if para in remotos and not desde_par:
        ok = await enviar_a_par({**sobre("reenvio"), "mensaje": msg})
        log.info("REENVIO  %-9s %s -> %s (nodo %s)", msg["tipo"], msg.get("de"), para, remotos[para])
        return ok
    return False


# ---------------------------------------------------------------- clientes
async def ws_cliente(request):
    ws = web.WebSocketResponse(heartbeat=20)
    await ws.prepare(request)
    usuario = None
    ip = request.remote
    try:
        async for m in ws:
            if m.type != WSMsgType.TEXT:
                continue
            try:
                msg = json.loads(m.data)
            except json.JSONDecodeError:
                await enviar_ws(ws, sobre("error", datos={"motivo": "JSON inválido"}))
                continue
            tipo = msg.get("tipo")

            if tipo == "registro":
                nombre = str(msg.get("de", "")).strip()[:32]
                if not nombre or nombre in locales or nombre in remotos:
                    await enviar_ws(ws, sobre("error", datos={"motivo": "Nombre vacío o en uso"}))
                    continue
                usuario = nombre
                locales[usuario] = ws
                log.info("REGISTRO %s desde %s", usuario, ip)
                await enviar_ws(ws, sobre("bienvenida", para=usuario, datos={"usuarios": directorio()}))
                presencia = sobre("presencia", de=usuario, datos={"estado": "conectado", "nodo": NODO})
                await avisar_locales(presencia, excepto=usuario)
                await enviar_a_par(presencia)
                continue

            if not usuario:
                await enviar_ws(ws, sobre("error", datos={"motivo": "Primero envía un registro"}))
                continue

            if tipo == "usuarios":
                await enviar_ws(ws, sobre("usuarios", para=usuario, datos={"usuarios": directorio()}))
            elif tipo in DIRIGIDOS:
                completo = {**sobre(tipo), **{k: msg.get(k) for k in ("para", "sala", "datos") if k in msg},
                            "de": usuario, "nodo": NODO}
                if completo["tipo"] == "chat":
                    log.info("CHAT     %s -> %s: %s", usuario, completo.get("para"),
                             str(completo.get("datos", {}).get("texto", ""))[:80])
                if not await entregar(completo):
                    await enviar_ws(ws, sobre("error", para=usuario,
                                              datos={"motivo": f"Usuario '{completo.get('para')}' no conectado"}))
            else:
                await enviar_ws(ws, sobre("error", datos={"motivo": f"Tipo desconocido: {tipo}"}))
    finally:
        if usuario and locales.get(usuario) is ws:
            del locales[usuario]
            log.info("SALIDA   %s", usuario)
            presencia = sobre("presencia", de=usuario, datos={"estado": "desconectado", "nodo": NODO})
            await avisar_locales(presencia)
            await enviar_a_par(presencia)
    return ws


# ---------------------------------------------------------------- federación entre nodos
async def procesar_federacion(ws, origen):
    enlaces.add(ws)
    log.info("ENLACE   abierto con %s (%d enlace/s)", origen, len(enlaces))
    await enviar_ws(ws, sobre("hola_nodo", datos={"usuarios": sorted(locales)}))
    try:
        async for m in ws:
            if m.type != WSMsgType.TEXT:
                continue
            msg = json.loads(m.data)
            tipo, nodo_par = msg.get("tipo"), msg.get("nodo")
            if tipo == "hola_nodo":
                for u in msg["datos"].get("usuarios", []):
                    remotos[u] = nodo_par
                log.info("ENLACE   %s tiene %d usuario/s: %s", nodo_par, len(msg["datos"]["usuarios"]),
                         ", ".join(msg["datos"]["usuarios"]) or "-")
                for u in msg["datos"].get("usuarios", []):
                    await avisar_locales(sobre("presencia", de=u, datos={"estado": "conectado", "nodo": nodo_par}))
            elif tipo == "presencia":
                if msg["datos"]["estado"] == "conectado":
                    remotos[msg["de"]] = nodo_par
                else:
                    remotos.pop(msg["de"], None)
                log.info("PRESENCIA %s %s en %s", msg["de"], msg["datos"]["estado"], nodo_par)
                await avisar_locales(msg)
            elif tipo == "reenvio":
                interno = msg["mensaje"]
                log.info("RECIBIDO %-9s %s -> %s (desde %s)", interno["tipo"], interno.get("de"),
                         interno.get("para"), nodo_par)
                await entregar(interno, desde_par=True)
    finally:
        enlaces.discard(ws)
        log.info("ENLACE   cerrado con %s", origen)
        if not enlaces:
            for u in list(remotos):
                remotos.pop(u)
                await avisar_locales(sobre("presencia", de=u, datos={"estado": "desconectado", "nodo": "?"}))


async def ws_federacion(request):
    ws = web.WebSocketResponse(heartbeat=20)
    await ws.prepare(request)
    await procesar_federacion(ws, f"{request.remote} (entrante)")
    return ws


async def conectar_par(app):
    """Mantiene un enlace saliente al otro nodo, reintentando cada 3 s."""
    if not PAR:
        log.info("Sin NODO_PAR: este nodo solo acepta enlaces entrantes")
        return
    async with ClientSession() as sesion:
        while True:
            if enlaces:                       # ya hay enlace (entrante o saliente)
                await asyncio.sleep(3)
                continue
            try:
                async with sesion.ws_connect(PAR, heartbeat=20) as ws:
                    await procesar_federacion(ws, f"{PAR} (saliente)")
            except (ClientError, OSError) as e:
                log.info("ENLACE   no se pudo conectar a %s (%s); reintento en 3 s", PAR, type(e).__name__)
            await asyncio.sleep(3)


# ---------------------------------------------------------------- HTTP
async def salud(request):
    return web.json_response({"nodo": NODO, "par": PAR, "enlace_activo": bool(enlaces),
                              "usuarios_locales": sorted(locales), "usuarios_remotos": remotos})


async def indice(request):
    archivo = WEB / "index.html"
    if archivo.exists():
        return web.FileResponse(archivo)
    return web.Response(text=f"Mensajero WebRTC - {NODO}. La interfaz llega en la fase 3; usa /ws o /salud.\n")


async def al_iniciar(app):
    app["tarea_par"] = asyncio.create_task(conectar_par(app))


async def al_cerrar(app):
    app["tarea_par"].cancel()


def crear_app():
    app = web.Application()
    app.router.add_get("/", indice)
    app.router.add_get("/ws", ws_cliente)
    app.router.add_get("/federacion", ws_federacion)
    app.router.add_get("/salud", salud)
    if WEB.exists():
        app.router.add_static("/static/", WEB)
    app.on_startup.append(al_iniciar)
    app.on_cleanup.append(al_cerrar)
    return app


if __name__ == "__main__":
    log.info("Iniciando nodo %s en el puerto %d; par: %s", NODO, PUERTO, PAR or "(ninguno)")
    web.run_app(crear_app(), host="0.0.0.0", port=PUERTO, print=None, access_log=None)
