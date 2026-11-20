#!/usr/bin/env bash
# Copia el servidor y la interfaz web actuales a nodo1 y nodo2 y reinicia el servicio,
# sin recrear los contenedores. Ejecutar desde la raíz del repositorio en el anfitrión de Incus.
set -e
for n in nodo1 nodo2; do
  echo "== $n"
  incus exec "$n" -- mkdir -p /opt/mensajero/web
  incus file push servidor/servidor.py servidor/cliente_consola.py "$n"/opt/mensajero/
  incus file push servidor/web/* "$n"/opt/mensajero/web/
  incus exec "$n" -- systemctl restart mensajero
  incus exec "$n" -- systemctl is-active mensajero
done
