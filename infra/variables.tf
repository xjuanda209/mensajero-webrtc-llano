variable "imagen" {
  description = "Imagen con cloud-init para los nodos"
  type        = string
  default     = "images:ubuntu/24.04/cloud"
}

variable "red_nombre" {
  description = "Nombre de la red puente administrada por Incus"
  type        = string
  default     = "redmsg"
}

variable "red_ipv4" {
  description = "Dirección del puente y subred de los nodos"
  type        = string
  default     = "10.77.0.1/24"
}

variable "pool" {
  description = "Pool de almacenamiento de Incus (lo crea 'incus admin init')"
  type        = string
  default     = "default"
}

variable "puerto" {
  description = "Puerto HTTP/WebSocket del servidor de señalización en cada nodo"
  type        = number
  default     = 8080
}

variable "dominio" {
  description = "Dirección con la que los navegadores abren el mensajero (IP del anfitrión en local, nombre DNS en la nube)"
  type        = string
  default     = "192.168.56.20"
}

variable "tls_interno" {
  description = "true: certificado de la CA interna de Caddy (local). false: Let's Encrypt automático (nube con dominio público)"
  type        = bool
  default     = true
}

variable "ice_servers" {
  description = "Servidores STUN/TURN que se entregan al navegador (JSON)"
  type        = string
  default     = "[{\"urls\": \"stun:stun.l.google.com:19302\"}]"
}
