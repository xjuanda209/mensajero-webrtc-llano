# Bitácora — Mensajero WebRTC

Una entrada por sesión de trabajo: fecha, tiempo dedicado, qué se hizo, problemas y soluciones, y uso de IA.

---

## Sesión 1 — 19 de noviembre de 2026

**Tiempo dedicado:** 3h

**Qué se hizo**
- Lectura de la guía del laboratorio y planeación del cronograma.
- Decisión de plataforma: contenedores de sistema Incus aprovisionados con Terraform y cloud-init (sugerencia del docente como opción más completa), con despliegue final en Azure for Students para usuarios reales.
- Decisión de hacer el RETO (videollamada grupal en malla y pantalla compartida).
- Investigación de los bloques A a H con fuentes primarias (RFC del IETF, especificaciones W3C, documentación de Incus, Terraform, MDN).
- Verificación práctica del proveedor de Terraform `lxc/incus` (v1.2.1): se ejecutó `terraform init` y `terraform providers schema` para confirmar los nombres reales de los recursos (`incus_network`, `incus_profile`, `incus_instance`, `incus_network_forward`).
- Diagramas UML en PlantUML: componentes, despliegue, secuencia de llamada, secuencia de archivo, estados de conexión, entrada a sala (RETO) y bosquejo de la interfaz.
- Redacción del informe de investigación (`docs/informe_investigacion.pdf`).

**Problemas y soluciones**
- La fase de investigación oficial era del 12 al 17 de noviembre y se inició tarde → se concentró la investigación en una sesión y se priorizó subir el informe antes de cualquier código, como exige la guía.
- Incus solo funciona en Linux y el equipo es Windows → se usará una máquina virtual Ubuntu Server 24.04 en VirtualBox como anfitrión de Incus.
- La cámara no funciona por HTTP en una IP que no sea localhost → se incluyó Caddy con HTTPS desde el diseño.

**Uso de IA**
- Se usó un asistente de IA (Claude) para organizar el plan de trabajo, buscar y verificar fuentes, generar borradores de las respuestas del informe y de los diagramas PlantUML. Todo el contenido fue revisado y las decisiones de arquitectura son propias.
