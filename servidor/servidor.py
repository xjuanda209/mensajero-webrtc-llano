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
WEB = Path(os.environ.get("WEB_DIR", Path(__file__).with_name("web")))
# Servidores ICE que se entregan al navegador (en la nube se agrega el TURN propio).
ICE = json.loads(os.environ.get("ICE_SERVERS", '[{"urls": "stun:stun.l.google.com:19302"}]'))

# Tipos que se enrutan a un destinatario (señalización WebRTC y chat).
DIRIGIDOS = {"chat", "oferta", "respuesta", "candidato", "llamada", "aceptar", "rechazar",
             "colgar", "ocupado", "clave"}   # "clave": intercambio de claves públicas ECDH para el chat cifrado

logging.basicConfig(level=logging.INFO, format=f"%(asctime)s [{NODO}] %(message)s", datefmt="%H:%M:%S")
log = logging.getLogger("mensajero")

locales: dict[str, web.WebSocketResponse] = {}   # usuario -> WebSocket del cliente en ESTE nodo
remotos: dict[str, str] = {}                      # usuario -> nombre del nodo donde está
enlaces: set = set()                              # WebSockets abiertos hacia/desde el otro nodo
salas: dict[str, dict[str, str]] = {}             # sala -> {usuario: nodo}  (estado replicado en ambos nodos)
presentador: dict[str, str] = {}                  # sala -> usuario que comparte pantalla
claves: dict[str, str] = {}                       # usuario -> clave de sesión (permite reconectar con el mismo nombre)
pendientes: list = []                             # mensajes para el otro nodo mientras el enlace está caído
GRACIA = 20                                       # s que se espera a que vuelva el enlace antes de dar por perdidos a los remotos
purga = None                                      # tarea programada que limpia a los remotos si el enlace no vuelve


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
    if remotos and len(pendientes) < 1000:    # enlace caído pero aún en periodo de gracia: guardar y reenviar al volver
        pendientes.append(msg)
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


# ---------------------------------------------------------------- salas (RETO: llamada grupal)
def resumen_salas():
    return [{"sala": n, "miembros": [{"usuario": u, "nodo": nd} for u, nd in sorted(m.items())],
             "presentador": presentador.get(n)} for n, m in sorted(salas.items()) if m]


async def publicar_salas():
    """Envía a todos los usuarios de ESTE nodo el estado de las salas."""
    await avisar_locales(sobre("salas", datos={"salas": resumen_salas()}))


async def avisar_sala(sala, tipo, quien, datos=None):
    """Notificación dirigida a cada miembro de la sala (local o en el otro nodo)."""
    for miembro in list(salas.get(sala, {})):
        if miembro != quien:
            await entregar(sobre(tipo, de=quien, para=miembro, sala=sala, datos=datos))


def aplicar_evento_sala(accion, sala, quien, nodo):
    if accion == "entro":
        salas.setdefault(sala, {})[quien] = nodo
    elif accion == "salio":
        salas.get(sala, {}).pop(quien, None)
        if presentador.get(sala) == quien:
            presentador.pop(sala, None)
        if not salas.get(sala):
            salas.pop(sala, None)
            presentador.pop(sala, None)
    elif accion == "pantalla_on":
        presentador[sala] = quien
    elif accion == "pantalla_off" and presentador.get(sala) == quien:
        presentador.pop(sala, None)


async def evento_sala(accion, sala, quien):
    """Aplica un cambio de sala local, lo replica al otro nodo y actualiza a los usuarios."""
    aplicar_evento_sala(accion, sala, quien, NODO)
    await enviar_a_par(sobre("sala_evento", de=quien, sala=sala, datos={"accion": accion}))
    await publicar_salas()


async def salir_de_sala(usuario, sala):
    if usuario not in salas.get(sala, {}):
        return
    if presentador.get(sala) == usuario:
        await avisar_sala(sala, "pantalla", usuario, {"activo": False})
    await avisar_sala(sala, "salio", usuario)
    await evento_sala("salio", sala, usuario)
    log.info("SALA     %s salió de '%s'", usuario, sala)


def nombre_sala(texto):
    limpio = "".join(c for c in str(texto or "").lower().strip().replace(" ", "-") if c.isalnum() or c in "-_")
    return limpio[:24]


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
                clave = str((msg.get("datos") or {}).get("clave", ""))[:64]
                anterior = locales.get(nombre)
                if anterior is not None and clave and claves.get(nombre) == clave:
                    # Reconexión del mismo navegador: reemplaza la sesión vieja sin sacarlo de sus salas.
                    usuario = nombre
                    locales[usuario] = ws
                    await anterior.close()
                    log.info("RECONEXION %s desde %s", usuario, ip)
                    await enviar_ws(ws, sobre("bienvenida", para=usuario, datos={"usuarios": directorio(), "salas": resumen_salas()}))
                    continue
                if not nombre or nombre in locales or nombre in remotos:
                    await enviar_ws(ws, sobre("error", datos={"motivo": "Nombre vacío o en uso"}))
                    continue
                usuario = nombre
                locales[usuario] = ws
                claves[usuario] = clave
                log.info("REGISTRO %s desde %s", usuario, ip)
                await enviar_ws(ws, sobre("bienvenida", para=usuario, datos={"usuarios": directorio(), "salas": resumen_salas()}))
                presencia = sobre("presencia", de=usuario, datos={"estado": "conectado", "nodo": NODO})
                await avisar_locales(presencia, excepto=usuario)
                await enviar_a_par(presencia)
                continue

            if not usuario:
                await enviar_ws(ws, sobre("error", datos={"motivo": "Primero envía un registro"}))
                continue

            if tipo == "usuarios":
                await enviar_ws(ws, sobre("usuarios", para=usuario, datos={"usuarios": directorio()}))
            elif tipo == "unirse":
                sala = nombre_sala(msg.get("sala"))
                if not sala:
                    await enviar_ws(ws, sobre("error", datos={"motivo": "Nombre de sala inválido"}))
                    continue
                for otra in [n for n, m in salas.items() if usuario in m and n != sala]:
                    await salir_de_sala(usuario, otra)        # una sala a la vez
                miembros = [{"usuario": u, "nodo": n} for u, n in salas.get(sala, {}).items() if u != usuario]
                await avisar_sala(sala, "entro", usuario, {"nodo": NODO})
                await evento_sala("entro", sala, usuario)
                await enviar_ws(ws, sobre("miembros", para=usuario, sala=sala,
                                          datos={"miembros": miembros, "presentador": presentador.get(sala)}))
                log.info("SALA     %s entró a '%s' (%d participante/s)", usuario, sala, len(salas[sala]))
            elif tipo == "salir":
                await salir_de_sala(usuario, nombre_sala(msg.get("sala")))
            elif tipo == "salas":
                await enviar_ws(ws, sobre("salas", datos={"salas": resumen_salas()}))
            elif tipo == "pantalla_sala":
                sala = nombre_sala(msg.get("sala"))
                activo = bool((msg.get("datos") or {}).get("activo"))
                if usuario not in salas.get(sala, {}):
                    continue
                actual = presentador.get(sala)
                if activo and actual not in (None, usuario):
                    await enviar_ws(ws, sobre("pantalla_denegada", sala=sala, datos={"presentador": actual}))
                    continue
                if not activo and actual != usuario:
                    continue
                await evento_sala("pantalla_on" if activo else "pantalla_off", sala, usuario)
                await avisar_sala(sala, "pantalla", usuario, {"activo": activo})
                await enviar_ws(ws, sobre("pantalla", de=usuario, sala=sala, datos={"activo": activo}))
                log.info("PANTALLA %s %s en '%s'", usuario, "comparte" if activo else "deja de compartir", sala)
            elif tipo == "chat_sala":
                sala = nombre_sala(msg.get("sala"))
                if usuario in salas.get(sala, {}):
                    await avisar_sala(sala, "chat_sala", usuario, {"texto": str((msg.get("datos") or {}).get("texto", ""))[:2000]})
            elif tipo in DIRIGIDOS:
                completo = {**sobre(tipo), **{k: msg.get(k) for k in ("para", "sala", "datos") if k in msg},
                            "de": usuario, "nodo": NODO}
                if completo.get("para") == usuario:
                    await enviar_ws(ws, sobre("error", para=usuario, datos={"motivo": "No puedes enviarte mensajes a ti mismo"}))
                    continue
                if completo["tipo"] == "chat":
                    d = completo.get("datos") or {}
                    # Con cifrado de extremo a extremo el servidor solo ve texto cifrado: no puede leerlo.
                    contenido = f"[cifrado E2E, {len(str(d.get('cifrado', '')))} car. base64]" if d.get("cifrado") else str(d.get("texto", ""))[:80]
                    log.info("CHAT     %s -> %s: %s", usuario, completo.get("para"), contenido)
                if not await entregar(completo):
                    await enviar_ws(ws, sobre("error", para=usuario,
                                              datos={"motivo": f"Usuario '{completo.get('para')}' no conectado"}))
            else:
                await enviar_ws(ws, sobre("error", datos={"motivo": f"Tipo desconocido: {tipo}"}))
    finally:
        if usuario and locales.get(usuario) is ws:
            for sala in [n for n, m in list(salas.items()) if usuario in m]:
                await salir_de_sala(usuario, sala)
            del locales[usuario]
            claves.pop(usuario, None)
            log.info("SALIDA   %s", usuario)
            presencia = sobre("presencia", de=usuario, datos={"estado": "desconectado", "nodo": NODO})
            await avisar_locales(presencia)
            await enviar_a_par(presencia)
    return ws


# ---------------------------------------------------------------- federación entre nodos
async def procesar_federacion(ws, origen):
    global purga
    enlaces.add(ws)
    log.info("ENLACE   abierto con %s (%d enlace/s)", origen, len(enlaces))
    salas_locales = {n: [u for u, nd in m.items() if nd == NODO] for n, m in salas.items()}
    await enviar_ws(ws, sobre("hola_nodo", datos={"usuarios": sorted(locales), "salas": salas_locales,
                                                   "presentador": {n: u for n, u in presentador.items() if u in locales}}))
    try:
        async for m in ws:
            if m.type != WSMsgType.TEXT:
                continue
            msg = json.loads(m.data)
            tipo, nodo_par = msg.get("tipo"), msg.get("nodo")
            if tipo == "hola_nodo":
                if purga:                                   # el enlace volvió dentro del periodo de gracia
                    purga.cancel(); purga = None
                vivos = set(msg["datos"].get("usuarios", []))
                for u in [u for u in remotos if u not in vivos]:   # remotos que ya no existen en el otro nodo
                    await olvidar_remoto(u)
                for u in vivos:
                    remotos[u] = nodo_par
                log.info("ENLACE   %s tiene %d usuario/s: %s", nodo_par, len(msg["datos"]["usuarios"]),
                         ", ".join(msg["datos"]["usuarios"]) or "-")
                for u in msg["datos"].get("usuarios", []):
                    await avisar_locales(sobre("presencia", de=u, datos={"estado": "conectado", "nodo": nodo_par}))
                for sala, miembros in msg["datos"].get("salas", {}).items():
                    for u in miembros:
                        nuevo = u not in salas.get(sala, {})
                        aplicar_evento_sala("entro", sala, u, nodo_par)
                        if nuevo:                           # avisar a los miembros locales para que lo conecten
                            for miembro in [x for x in salas[sala] if x in locales]:
                                await enviar_ws(locales[miembro], sobre("entro", de=u, para=miembro, sala=sala, datos={"nodo": nodo_par}))
                for sala in list(salas):                    # quien ya no está en esa sala del otro nodo, sale
                    for u in [u for u, nd in list(salas.get(sala, {}).items()) if nd == nodo_par and u not in msg["datos"].get("salas", {}).get(sala, [])]:
                        await sacar_remoto_de_sala(u, sala)
                if pendientes:
                    log.info("ENLACE   reenviando %d mensaje/s guardados", len(pendientes))
                    while pendientes:
                        await enviar_ws(ws, pendientes.pop(0))
                for sala, u in msg["datos"].get("presentador", {}).items():
                    aplicar_evento_sala("pantalla_on", sala, u, nodo_par)
                await publicar_salas()
            elif tipo == "sala_evento":
                aplicar_evento_sala(msg["datos"]["accion"], msg["sala"], msg["de"], nodo_par)
                log.info("SALA     (desde %s) %s %s '%s'", nodo_par, msg["de"], msg["datos"]["accion"], msg["sala"])
                await publicar_salas()
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
        if not enlaces and remotos:
            # No se saca a nadie de inmediato: un corte breve (CPU, red) no debe romper las salas.
            if purga:
                purga.cancel()
            purga = asyncio.create_task(purgar_remotos())


async def sacar_remoto_de_sala(u, sala):
    for miembro in [x for x in salas.get(sala, {}) if x in locales]:
        await enviar_ws(locales[miembro], sobre("salio", de=u, para=miembro, sala=sala))
    aplicar_evento_sala("salio", sala, u, "?")


async def olvidar_remoto(u):
    remotos.pop(u, None)
    for sala in [n for n, m in list(salas.items()) if u in m]:
        await sacar_remoto_de_sala(u, sala)
    await avisar_locales(sobre("presencia", de=u, datos={"estado": "desconectado", "nodo": "?"}))


async def purgar_remotos():
    """Si el enlace no vuelve en GRACIA segundos, se da por perdidos a los usuarios del otro nodo."""
    global purga
    await asyncio.sleep(GRACIA)
    purga = None
    if enlaces:
        return
    log.info("ENLACE   no volvió en %d s: se retiran %d usuario/s remotos", GRACIA, len(remotos))
    pendientes.clear()
    for u in list(remotos):
        await olvidar_remoto(u)
    await publicar_salas()


async def ws_federacion(request):
    ws = web.WebSocketResponse(heartbeat=30)
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
                async with sesion.ws_connect(PAR, heartbeat=30) as ws:
                    await procesar_federacion(ws, f"{PAR} (saliente)")
            except (ClientError, OSError) as e:
                log.info("ENLACE   no se pudo conectar a %s (%s); reintento en 3 s", PAR, type(e).__name__)
            await asyncio.sleep(3)


# ---------------------------------------------------------------- HTTP
async def salud(request):
    return web.json_response({"nodo": NODO, "par": PAR, "enlace_activo": bool(enlaces),
                              "usuarios_locales": sorted(locales), "usuarios_remotos": remotos,
                              "salas": resumen_salas()})


async def config(request):
    return web.json_response({"nodo": NODO, "iceServers": ICE})


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
    app.router.add_get("/config", config)
    if WEB.exists():
        app.router.add_static("/static/", WEB)
    app.on_startup.append(al_iniciar)
    app.on_cleanup.append(al_cerrar)
    return app


if __name__ == "__main__":
    log.info("Iniciando nodo %s en el puerto %d; par: %s", NODO, PUERTO, PAR or "(ninguno)")
    web.run_app(crear_app(), host="0.0.0.0", port=PUERTO, print=None, access_log=None)
