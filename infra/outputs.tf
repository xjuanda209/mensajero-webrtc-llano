output "nodos" {
  description = "IP de cada nodo en la red del mensajero"
  value       = { for k, v in incus_instance.nodo : k => v.ipv4_address }
}

output "url" {
  description = "Dirección para abrir el mensajero desde el navegador"
  value       = "https://${var.dominio}/  (asignacion automatica; forzar nodo: /nodo1/ o /nodo2/)"
}

output "siguiente_paso" {
  value = "Espera a cloud-init (1-3 min) y ejecuta ../scripts/probar_avance.sh"
}
