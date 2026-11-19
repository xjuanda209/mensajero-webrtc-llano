#!/usr/bin/env bash
# Demostracion del primer avance (sin interfaz): ejecutar en el anfitrion de Incus.
# Uso: ./scripts/probar_avance.sh
set -u
titulo() { printf '\n\033[1m== %s\033[0m\n' "$1"; }

titulo "1. Nodos creados por Terraform"
incus list nodo -c ns4

titulo "2. cloud-init terminado en ambos nodos"
for n in nodo1 nodo2; do printf '%s: ' "$n"; incus exec "$n" -- cloud-init status --wait | tail -1; done

titulo "3. Los nodos se encuentran POR NOMBRE (DNS de la red Incus)"
incus exec nodo1 -- getent hosts nodo2.incus
incus exec nodo2 -- getent hosts nodo1.incus

titulo "4. Servicio systemd activo"
for n in nodo1 nodo2; do printf '%s: ' "$n"; incus exec "$n" -- systemctl is-active mensajero; done

titulo "5. Estado de la senalizacion (/salud)"
for n in nodo1 nodo2; do incus exec "$n" -- curl -s http://localhost:8080/salud; echo; done

titulo "6. Mensaje de beto (nodo2) a ana (nodo1)"
incus exec nodo1 -- timeout 8 python3 /opt/mensajero/cliente_consola.py ws://localhost:8080/ws ana </dev/null &
sleep 3
incus exec nodo2 -- python3 /opt/mensajero/cliente_consola.py ws://localhost:8080/ws beto \
  --para ana --texto "Hola ana, soy beto desde nodo2" </dev/null
wait

titulo "7. Logs de ambos nodos"
for n in nodo1 nodo2; do echo "--- $n"; incus exec "$n" -- journalctl -u mensajero -n 12 --no-pager -o cat; done
