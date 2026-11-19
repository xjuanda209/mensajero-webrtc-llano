#!/usr/bin/env python3
"""
Cliente de consola para probar la señalización sin interfaz gráfica.

Uso interactivo:
    python3 cliente_consola.py ws://localhost:8080/ws ana
    > beto: hola desde nodo1        (mensaje directo a beto)
    > *: hola a todos               (mensaje a todos los usuarios)
    > /usuarios                     (directorio de ambos nodos)
    > /salir

Uso de un solo envío (para scripts):
    python3 cliente_consola.py ws://localhost:8080/ws ana --para beto --texto "hola"
"""
import argparse
import asyncio
import json
import sys

from aiohttp import ClientSession, WSMsgType


def mostrar(msg):
    tipo, de, datos = msg.get("tipo"), msg.get("de"), msg.get("datos", {})
    if tipo == "chat":
        print(f"\n[{msg.get('nodo')}] {de}: {datos.get('texto')}")
    elif tipo == "presencia":
        print(f"\n* {de} {datos.get('estado')} (nodo {datos.get('nodo')})")
    elif tipo in ("bienvenida", "usuarios"):
        lista = ", ".join(f"{u['usuario']}@{u['nodo']}" for u in datos.get("usuarios", []))
        print(f"\n* Usuarios: {lista or '(ninguno)'}")
    elif tipo == "error":
        print(f"\n! Error: {datos.get('motivo')}")
    else:
        print(f"\n{json.dumps(msg, ensure_ascii=False)}")
    print("> ", end="", flush=True)


async def recibir(ws):
    async for m in ws:
        if m.type == WSMsgType.TEXT:
            mostrar(json.loads(m.data))


async def interactivo(ws):
    loop = asyncio.get_running_loop()
    print("Escribe 'destino: texto', '/usuarios' o '/salir'.\n> ", end="", flush=True)
    while True:
        crudo = await loop.run_in_executor(None, sys.stdin.readline)
        if crudo == "":                      # sin teclado (EOF): solo escuchar
            await asyncio.Event().wait()
        linea = crudo.strip()
        if not linea:
            continue
        if linea == "/salir":
            break
        if linea == "/usuarios":
            await ws.send_json({"tipo": "usuarios"})
            continue
        if ":" not in linea:
            print("Formato: destino: texto\n> ", end="", flush=True)
            continue
        para, texto = (x.strip() for x in linea.split(":", 1))
        await ws.send_json({"tipo": "chat", "para": para, "datos": {"texto": texto}})


async def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("url")
    ap.add_argument("usuario")
    ap.add_argument("--para")
    ap.add_argument("--texto")
    a = ap.parse_args()
    async with ClientSession() as s, s.ws_connect(a.url) as ws:
        await ws.send_json({"tipo": "registro", "de": a.usuario})
        lector = asyncio.create_task(recibir(ws))
        if a.para and a.texto:
            await asyncio.sleep(0.5)
            await ws.send_json({"tipo": "chat", "para": a.para, "datos": {"texto": a.texto}})
            await asyncio.sleep(1)
        else:
            await interactivo(ws)
        lector.cancel()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
