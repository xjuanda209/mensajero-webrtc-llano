# Mensajero WebRTC - infraestructura de los dos nodos con Incus
# terraform init && terraform apply

locals {
  # Cada nodo conoce a su par POR NOMBRE (DNS de la red Incus), nunca por IP.
  nodos = {
    nodo1 = { par = "ws://nodo2.incus:${var.puerto}/federacion" }
    nodo2 = { par = "ws://nodo1.incus:${var.puerto}/federacion" }
  }
  servidor_b64 = filebase64("${path.module}/../servidor/servidor.py")
  cliente_b64  = filebase64("${path.module}/../servidor/cliente_consola.py")
}

# Red puente propia: DHCP y DNS (dnsmasq) con el dominio .incus, NAT hacia Internet.
resource "incus_network" "red" {
  name        = var.red_nombre
  description = "Red del mensajero WebRTC"
  config = {
    "ipv4.address" = var.red_ipv4
    "ipv4.nat"     = "true"
    "ipv6.address" = "none"
    "dns.domain"   = "incus"
  }
}

# Perfil comun: limites de recursos, disco raiz y tarjeta de red en la red del mensajero.
resource "incus_profile" "nodo" {
  name        = "mensajero-nodo"
  description = "Nodo de senalizacion del mensajero"
  config = {
    "limits.cpu"    = "1"
    "limits.memory" = "512MiB"
  }
  device {
    name = "root"
    type = "disk"
    properties = {
      path = "/"
      pool = var.pool
    }
  }
  device {
    name = "eth0"
    type = "nic"
    properties = {
      network = incus_network.red.name
    }
  }
}

# Los dos nodos: contenedores de sistema configurados con cloud-init.
resource "incus_instance" "nodo" {
  for_each    = local.nodos
  name        = each.key
  description = "Servidor de senalizacion ${each.key}"
  image       = var.imagen
  profiles    = [incus_profile.nodo.name]

  config = {
    "cloud-init.user-data" = templatefile("${path.module}/cloud-init/nodo.yaml.tftpl", {
      nombre       = each.key
      par          = each.value.par
      puerto       = var.puerto
      servidor_b64 = local.servidor_b64
      cliente_b64  = local.cliente_b64
    })
  }

  wait_for {
    type = "ipv4"
  }
}
