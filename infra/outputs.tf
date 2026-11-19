output "nodos" {
  description = "IP de cada nodo en la red del mensajero"
  value       = { for k, v in incus_instance.nodo : k => v.ipv4_address }
}

output "siguiente_paso" {
  value = "Espera a cloud-init: incus exec nodo1 -- cloud-init status --wait ; luego ../scripts/probar_avance.sh"
}
