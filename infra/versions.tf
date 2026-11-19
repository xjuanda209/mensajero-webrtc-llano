terraform {
  required_version = ">= 1.6"
  required_providers {
    incus = {
      source  = "lxc/incus"
      version = "~> 1.2"
    }
  }
}

# Sin bloque "remote": usa el Incus local del anfitrión (socket unix).
# En la fase de nube se agrega un remote apuntando al Incus de la VM de Azure.
provider "incus" {}
