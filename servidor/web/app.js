/* Mensajero WebRTC - cliente web
 * Señalización: WebSocket con el nodo (/ws). Medios y archivos: WebRTC entre navegadores.
 * Cada contacto con el que se habla tiene un objeto Par (una RTCPeerConnection + un DataChannel).
 */
"use strict";
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const BASE = location.pathname.replace(/[^/]*$/, "");          // "/nodo1/" detrás del proxy, "/" directo
const COLORES = ["#00a884", "#7f66ff", "#ff8a00", "#e2457a", "#009de2", "#a5b337", "#5f66cd", "#c05f3c"];
const colorDe = (n) => { let h = 0; for (const c of n) h = (h * 31 + c.charCodeAt(0)) >>> 0; return COLORES[h % COLORES.length]; };
const hora = (ts = Date.now()) => new Date(ts).toLocaleTimeString("es-CO", { hour: "numeric", minute: "2-digit" });
const tamano = (n) => n < 1024 ? n + " B" : n < 1048576 ? (n / 1024).toFixed(1) + " KB" : (n / 1048576).toFixed(1) + " MB";
const FRAGMENTO = 16 * 1024;            // 16 KiB por mensaje del DataChannel
const BUFER_MAX = 1024 * 1024;          // pausar si hay más de 1 MiB en cola
const BUFER_BAJO = 256 * 1024;          // reanudar con el evento bufferedamountlow

const S = {
  yo: null, nodo: "", ice: [], ws: null, registrado: false,
  usuarios: new Map(),        // nombre -> { nodo, conectado }
  conversaciones: new Map(),  // nombre -> [items]
  noLeidos: new Map(),
  abierto: null,
  pares: new Map(),           // nombre -> Par
  llamada: null,              // { con, estado, local, inicio, timer }
  sala: null,                 // { nombre, local, miembros: Map(usuario -> nodo), presentador, pantalla }
  salas: [],                  // resumen de salas activas en ambos nodos
  entrante: null,             // { de, timer }
};
window.__mensajero = S;       // para depurar desde la consola del navegador

// ------------------------------------------------------------------ utilidades de interfaz
let tAviso;
function aviso(texto, error = false) {
  const a = $("aviso"); a.textContent = texto; a.className = error ? "error" : ""; clearTimeout(tAviso);
  tAviso = setTimeout(() => a.classList.add("oculto"), error ? 6000 : 3500);
}
function avatar(el, nombre, conectado) {
  el.style.background = colorDe(nombre); el.textContent = nombre[0] || "?";
  if (conectado !== undefined) { const i = document.createElement("i"); if (conectado) i.className = "on"; el.appendChild(i); }
}
async function sha256(buffer) {
  const h = await crypto.subtle.digest("SHA-256", buffer);
  return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// ------------------------------------------------------------------ señalización (WebSocket)
function senal(msg) {
  if (S.ws && S.ws.readyState === WebSocket.OPEN) { S.ws.send(JSON.stringify(msg)); return true; }
  return false;
}
function conectar() {
  const url = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}${BASE}ws`;
  const ws = new WebSocket(url);
  S.ws = ws;
  ws.onopen = () => ws.send(JSON.stringify({ tipo: "registro", de: S.yo }));
  ws.onmessage = (e) => alMensajeServidor(JSON.parse(e.data));
  ws.onclose = () => {
    $("senal").className = "senal mal";
    if (S.registrado) { aviso("Se perdió la conexión con el servidor de señalización. Reintentando…", true); setTimeout(conectar, 3000); }
  };
}
function alMensajeServidor(m) {
  const d = m.datos || {};
  switch (m.tipo) {
    case "bienvenida":
      S.registrado = true;
      $("senal").className = "senal ok";
      for (const u of d.usuarios) if (u.usuario !== S.yo) S.usuarios.set(u.usuario, { nodo: u.nodo, conectado: true });
      S.salas = d.salas || [];
      try { localStorage.setItem("mensajero_nombre", S.yo); } catch (e) {}
      if ($("app").classList.contains("oculto")) entrar();
      pintarLista(); pintarSalas();
      break;
    case "error":
      if (!S.registrado) { $("errorAcceso").textContent = d.motivo; S.yo = null; S.ws.close(); }
      else aviso(d.motivo, true);
      break;
    case "presencia": {
      if (m.de === S.yo) break;
      const conectado = d.estado === "conectado";
      S.usuarios.set(m.de, { nodo: d.nodo, conectado });
      if (!conectado) alDesconectarse(m.de);
      pintarLista(); if (S.abierto === m.de) pintarCabecera();
      break;
    }
    case "chat":
      agregarItem(m.de, { tipo: "texto", mio: false, texto: d.texto, ts: Date.now() });
      break;
    case "oferta": case "respuesta":
      obtenerPar(m.de).encolar(() => obtenerPar(m.de).alDescripcion(d.descripcion));
      break;
    case "candidato":
      obtenerPar(m.de).encolar(() => obtenerPar(m.de).alCandidato(d.candidato));
      break;
    case "llamada": if (S.sala) senal({ tipo: "ocupado", para: m.de }); else llamadaEntrante(m.de); break;
    case "salas": S.salas = d.salas || []; pintarSalas(); break;
    case "miembros": if (S.sala && m.sala === S.sala.nombre) { S.sala.presentador = d.presentador; for (const x of d.miembros) agregarMiembro(x.usuario, x.nodo); pintarGrupo(); } break;
    case "entro": if (S.sala && m.sala === S.sala.nombre) { agregarMiembro(m.de, d.nodo); pintarGrupo(); mensajeSala(`${m.de} entró a la sala`); } break;
    case "salio": if (S.sala && m.sala === S.sala.nombre) { quitarMiembro(m.de); mensajeSala(`${m.de} salió de la sala`); } break;
    case "pantalla": if (S.sala && m.sala === S.sala.nombre) alCambiarPantalla(m.de, d.activo); break;
    case "pantalla_denegada": cancelarPantalla(`${d.presentador} ya está compartiendo pantalla. Espera a que termine.`); break;
    case "chat_sala": if (S.sala && m.sala === S.sala.nombre) mensajeSala(d.texto, m.de); break;
    case "aceptar": llamadaAceptada(m.de); break;
    case "rechazar": case "ocupado":
      if (S.llamada && S.llamada.con === m.de) terminarLlamada(m.tipo === "ocupado" ? `${m.de} está en otra llamada` : `${m.de} rechazó la llamada${d.motivo ? " (" + d.motivo + ")" : ""}`, false);
      break;
    case "colgar":
      if (S.entrante && S.entrante.de === m.de) { cerrarModal(); agregarItem(m.de, sistema(`Llamada perdida de ${m.de}`)); }
      if (S.llamada && S.llamada.con === m.de) terminarLlamada(`${m.de} colgó`, false);
      break;
  }
}

// ------------------------------------------------------------------ Par: conexión WebRTC con un contacto
class Par {
  constructor(nombre) {
    this.nombre = nombre;
    this.polite = S.yo < nombre;           // perfect negotiation: rol determinista
    this.makingOffer = false; this.ignoreOffer = false;
    this.cadena = Promise.resolve();       // procesa la señalización en orden
    this.cola = Promise.resolve();         // un archivo a la vez
    this.senders = []; this.recibiendo = null; this.esperas = new Map();
    const pc = this.pc = new RTCPeerConnection({ iceServers: S.ice });
    // Canal de datos negociado (mismo id en ambos lados): confiable y ordenado por defecto.
    this.dc = pc.createDataChannel("archivos", { negotiated: true, id: 0 });
    this.dc.binaryType = "arraybuffer";
    this.dc.bufferedAmountLowThreshold = BUFER_BAJO;
    this.dc.onmessage = (e) => this.alDato(e.data);
    this.dc.onclose = () => this.alCerrarCanal();

    pc.onnegotiationneeded = async () => {
      if (pc.signalingState !== "stable") return;
      try {
        this.makingOffer = true;
        await pc.setLocalDescription();
        senal({ tipo: "oferta", para: this.nombre, datos: { descripcion: pc.localDescription.toJSON() } });
      } catch (e) { console.error("negociación", e); } finally { this.makingOffer = false; }
    };
    pc.onicecandidate = ({ candidate }) => candidate && senal({ tipo: "candidato", para: this.nombre, datos: { candidato: candidate.toJSON() } });
    pc.ontrack = (e) => {
      const flujo0 = e.streams[0] || new MediaStream([e.track]);
      if (S.sala && S.sala.miembros.has(this.nombre)) {
        const v = document.querySelector(`.tile[data-u="${CSS.escape(this.nombre)}"] video`);
        if (v) { v.srcObject = flujo0; v.parentElement.querySelector(".espera")?.remove(); }
        return;
      }
      if (!S.llamada || S.llamada.con !== this.nombre) return;
      const flujo = flujo0;
      $("videoRemoto").srcObject = flujo; $("sinVideo").classList.add("oculto");
      textoConexion(this);
    };
    pc.onconnectionstatechange = () => {
      const st = pc.connectionState;
      textoConexion(this);
      if (st === "connected" && S.sala && S.sala.miembros.has(this.nombre)) ajustarBitrate();
      if (st === "failed") aviso(`No se pudo establecer la conexión directa con ${this.nombre} (puede requerir TURN).`, true);
    };
  }
  encolar(fn) { this.cadena = this.cadena.then(fn).catch((e) => console.error(e)); return this.cadena; }

  async alDescripcion(desc) {
    const colision = desc.type === "offer" && (this.makingOffer || this.pc.signalingState !== "stable");
    this.ignoreOffer = !this.polite && colision;
    if (this.ignoreOffer) return;                         // el "impolite" ignora la oferta que choca
    await this.pc.setRemoteDescription(desc);             // el "polite" hace rollback implícito
    if (desc.type === "offer") {
      await this.pc.setLocalDescription();
      senal({ tipo: "respuesta", para: this.nombre, datos: { descripcion: this.pc.localDescription.toJSON() } });
    }
  }
  async alCandidato(c) {
    try { await this.pc.addIceCandidate(c); } catch (e) { if (!this.ignoreOffer) throw e; }
  }

  agregarMedios(flujo) { for (const t of flujo.getTracks()) this.senders.push(this.pc.addTrack(t, flujo)); }
  quitarMedios() {
    for (const s of this.senders) { try { this.pc.removeTrack(s); } catch (e) { /* conexión cerrada */ } }
    this.senders = [];
  }

  esperarCanal(ms = 20000) {
    if (this.dc.readyState === "open") return Promise.resolve();
    return new Promise((ok, mal) => {
      const t = setTimeout(() => mal(new Error("No se pudo abrir el canal directo")), ms);
      this.dc.addEventListener("open", () => { clearTimeout(t); ok(); }, { once: true });
    });
  }
  esperarBufer() {
    return new Promise((ok, mal) => {
      const t = setInterval(() => { if (this.dc.readyState !== "open") { clearInterval(t); mal(new Error("Canal cerrado")); } }, 500);
      this.dc.addEventListener("bufferedamountlow", () => { clearInterval(t); ok(); }, { once: true });
    });
  }

  // ---- envío de archivos por fragmentos
  enviar(archivo, item) { this.cola = this.cola.then(() => this._enviar(archivo, item)).catch(() => {}); }
  async _enviar(archivo, item) {
    try {
      actualizarArchivo(item, { estado: "conectando" });
      await this.esperarCanal();
      actualizarArchivo(item, { estado: "calculando" });
      const hash = await sha256(await archivo.arrayBuffer());
      const total = Math.ceil(archivo.size / FRAGMENTO) || 1;
      this.dc.send(JSON.stringify({ tipo: "archivo-inicio", id: item.id, nombre: archivo.name, mime: archivo.type, tamano: archivo.size, fragmentos: total, sha256: hash }));
      for (let o = 0; o < archivo.size; o += FRAGMENTO) {
        if (this.dc.readyState !== "open") throw new Error("el otro extremo cerró la conexión");
        if (this.dc.bufferedAmount > BUFER_MAX) await this.esperarBufer();   // control de flujo
        this.dc.send(await archivo.slice(o, o + FRAGMENTO).arrayBuffer());
        actualizarArchivo(item, { estado: "enviando", progreso: Math.min(1, (o + FRAGMENTO) / archivo.size) });
      }
      this.dc.send(JSON.stringify({ tipo: "archivo-fin", id: item.id }));
      actualizarArchivo(item, { estado: "confirmando", progreso: 1 });
      const ok = await new Promise((res, rej) => {
        this.esperas.set(item.id, res);
        setTimeout(() => rej(new Error("Sin confirmación")), 60000);
      });
      actualizarArchivo(item, { estado: ok ? "enviado" : "corrupto" });
    } catch (e) {
      actualizarArchivo(item, { estado: "interrumpido" });
      const motivo = this.dc.readyState !== "open" ? "el otro extremo cerró la conexión" : e.message;
      aviso(`Archivo «${item.nombre}» interrumpido: ${motivo}`, true);
    }
  }

  // ---- recepción
  async alDato(dato) {
    if (typeof dato !== "string") {
      const r = this.recibiendo; if (!r) return;
      r.partes.push(dato); r.bytes += dato.byteLength;
      actualizarArchivo(r.item, { estado: "recibiendo", progreso: r.bytes / r.meta.tamano });
      return;
    }
    const m = JSON.parse(dato);
    if (m.tipo === "archivo-inicio") {
      const item = { tipo: "archivo", mio: false, id: m.id, nombre: m.nombre, mime: m.mime, tamano: m.tamano, progreso: 0, estado: "recibiendo", ts: Date.now() };
      this.recibiendo = { meta: m, partes: [], bytes: 0, item };
      agregarItem(this.nombre, item);
    } else if (m.tipo === "archivo-fin") {
      const r = this.recibiendo; this.recibiendo = null; if (!r) return;
      const blob = new Blob(r.partes, { type: r.meta.mime || "application/octet-stream" });
      const ok = r.bytes === r.meta.tamano && (await sha256(await blob.arrayBuffer())) === r.meta.sha256;
      if (ok) actualizarArchivo(r.item, { estado: "recibido", progreso: 1, url: URL.createObjectURL(blob) });
      else actualizarArchivo(r.item, { estado: "corrupto" });
      if (this.dc.readyState === "open") this.dc.send(JSON.stringify({ tipo: ok ? "archivo-ok" : "archivo-error", id: m.id }));
    } else if (m.tipo === "archivo-ok" || m.tipo === "archivo-error") {
      const res = this.esperas.get(m.id); this.esperas.delete(m.id); if (res) res(m.tipo === "archivo-ok");
    }
  }
  alCerrarCanal() {
    if (this.recibiendo) { actualizarArchivo(this.recibiendo.item, { estado: "interrumpido" }); aviso(`Recepción de «${this.recibiendo.item.nombre}» interrumpida`, true); }
    this.recibiendo = null;
  }
  cerrar() { this.quitarMedios(); try { this.dc.close(); } catch (e) {} try { this.pc.close(); } catch (e) {} this.alCerrarCanal(); }
}
function textoConexion(par) {
  if (!S.llamada || S.llamada.con !== par.nombre || S.llamada.estado !== "activa") return;
  const st = par.pc.connectionState;
  $("estadoLlamada").textContent = st === "connected" ? "En llamada · conexión directa (P2P)" : st === "disconnected" ? "Reconectando…" : "Conectando…";
}
function obtenerPar(nombre) {
  let p = S.pares.get(nombre);
  if (!p || p.pc.connectionState === "closed" || p.pc.connectionState === "failed") { if (p) p.cerrar(); p = new Par(nombre); S.pares.set(nombre, p); }
  return p;
}
function alDesconectarse(nombre) {
  if (S.entrante && S.entrante.de === nombre) cerrarModal();
  if (S.llamada && S.llamada.con === nombre) terminarLlamada(`${nombre} se desconectó`, false);
  const p = S.pares.get(nombre); if (p) { p.cerrar(); S.pares.delete(nombre); }
}

// ------------------------------------------------------------------ videollamada
async function obtenerMedios() {
  try {
    return await navigator.mediaDevices.getUserMedia({ audio: true, video: { width: { ideal: 640 }, height: { ideal: 480 } } });
  } catch (e) {
    if (e.name === "NotAllowedError") throw new Error("Permiso de cámara o micrófono negado. Actívalo en el candado de la barra de direcciones.");
    if (e.name === "NotFoundError") {
      try { const a = await navigator.mediaDevices.getUserMedia({ audio: true }); aviso("No se encontró cámara: la llamada será solo de audio."); return a; }
      catch (e2) { throw new Error("No se encontró cámara ni micrófono."); }
    }
    if (e.name === "NotSupportedError" || e.name === "SecurityError") throw new Error("El navegador bloqueó la cámara (permiso negado o página no segura).");
    if (!window.isSecureContext) throw new Error("La cámara solo funciona por HTTPS o localhost.");
    throw new Error("No se pudo acceder a la cámara: " + e.message);
  }
}
function mostrarLlamada(texto) {
  $("llamada").classList.remove("oculto"); $("estadoLlamada").textContent = texto;
  $("videoLocal").srcObject = S.llamada.local; $("videoRemoto").srcObject = null; $("sinVideo").classList.remove("oculto");
  $("btnMic").classList.remove("apagado"); $("btnCam").classList.remove("apagado"); $("btnLlamar").disabled = true;
}
async function llamar() {
  const con = S.abierto;
  if (!con || S.llamada) return;
  if (S.sala) return aviso("Sal de la sala para hacer una llamada individual", true);
  if (!S.usuarios.get(con)?.conectado) return aviso(`${con} no está conectado`, true);
  let local;
  try { local = await obtenerMedios(); } catch (e) { return aviso(e.message, true); }
  S.llamada = { con, estado: "llamando", local, inicio: 0 };
  mostrarLlamada(`Llamando a ${con}…`);
  senal({ tipo: "llamada", para: con });
  S.llamada.timer = setTimeout(() => { if (S.llamada && S.llamada.estado === "llamando") terminarLlamada(`${con} no contestó`, true); }, 30000);
}
function llamadaEntrante(de) {
  if (S.llamada || S.entrante) return senal({ tipo: "ocupado", para: de });
  S.entrante = { de, timer: setTimeout(() => { senal({ tipo: "rechazar", para: de, datos: { motivo: "no contestó" } }); cerrarModal(); agregarItem(de, sistema(`Llamada perdida de ${de}`)); }, 30000) };
  const av = $("entranteAvatar"); av.innerHTML = ""; avatar(av, de);
  $("entranteTexto").textContent = `${de} te está llamando`;
  $("modalLlamada").classList.remove("oculto");
}
function cerrarModal() { if (S.entrante) clearTimeout(S.entrante.timer); S.entrante = null; $("modalLlamada").classList.add("oculto"); }
async function aceptar() {
  const de = S.entrante.de; cerrarModal();
  let local;
  try { local = await obtenerMedios(); }
  catch (e) { senal({ tipo: "rechazar", para: de, datos: { motivo: "sin cámara/micrófono" } }); return aviso(e.message, true); }
  abrirChat(de);
  S.llamada = { con: de, estado: "activa", local, inicio: Date.now() };
  mostrarLlamada("Conectando…");
  obtenerPar(de).agregarMedios(local);
  textoConexion(obtenerPar(de));
  senal({ tipo: "aceptar", para: de });
}
function llamadaAceptada(de) {
  if (!S.llamada || S.llamada.con !== de || S.llamada.estado !== "llamando") return;
  clearTimeout(S.llamada.timer);
  S.llamada.estado = "activa"; S.llamada.inicio = Date.now();
  $("estadoLlamada").textContent = "Conectando…";
  obtenerPar(de).agregarMedios(S.llamada.local);
  textoConexion(obtenerPar(de));
}
function terminarLlamada(motivo, avisar) {
  const ll = S.llamada; if (!ll) return;
  clearTimeout(ll.timer);
  if (avisar) senal({ tipo: "colgar", para: ll.con });
  ll.local.getTracks().forEach((t) => t.stop());
  const p = S.pares.get(ll.con); if (p) p.quitarMedios();
  S.llamada = null;
  $("llamada").classList.add("oculto"); $("videoRemoto").srcObject = null; $("videoLocal").srcObject = null; $("btnLlamar").disabled = false;
  const dur = ll.inicio ? ` · ${Math.round((Date.now() - ll.inicio) / 1000)} s` : "";
  agregarItem(ll.con, sistema(`${motivo || "Llamada finalizada"}${dur}`));
}
function alternar(tipo, boton) {
  if (!S.llamada) return;
  const pistas = tipo === "audio" ? S.llamada.local.getAudioTracks() : S.llamada.local.getVideoTracks();
  if (!pistas.length) return aviso(tipo === "audio" ? "No hay micrófono" : "No hay cámara", true);
  const activo = !pistas[0].enabled;
  pistas.forEach((t) => (t.enabled = activo));
  boton.classList.toggle("apagado", !activo);
}

// ------------------------------------------------------------------ conversaciones
const sistema = (texto) => ({ tipo: "sistema", texto, ts: Date.now() });
function agregarItem(con, item) {
  if (!S.conversaciones.has(con)) S.conversaciones.set(con, []);
  S.conversaciones.get(con).push(item);
  if (S.abierto === con) { $("mensajes").insertAdjacentHTML("beforeend", htmlItem(item)); bajar(); }
  else if (!item.mio && item.tipo !== "sistema") S.noLeidos.set(con, (S.noLeidos.get(con) || 0) + 1);
  pintarLista();
}
function bajar() { const m = $("mensajes"); m.scrollTop = m.scrollHeight; }
const ESTADOS = {
  preparando: "Preparando…", conectando: "Abriendo canal directo…", calculando: "Calculando SHA-256…",
  enviando: "Enviando", confirmando: "Esperando confirmación…", enviado: "Entregado · SHA-256 verificado ✓",
  recibiendo: "Recibiendo", recibido: "Recibido íntegro · SHA-256 verificado ✓",
  corrupto: "Error: el archivo llegó dañado (SHA-256 distinto)", interrumpido: "Archivo interrumpido",
};
function textoEstado(it) {
  const pct = ["enviando", "recibiendo"].includes(it.estado) ? ` ${Math.floor((it.progreso || 0) * 100)} %` : "";
  return `${tamano(it.tamano)} · ${ESTADOS[it.estado] || it.estado}${pct}`;
}
function contenidoArchivo(it) {
  if (!it.url) return "";
  const m = it.mime || "";
  let vista = "";
  if (m.startsWith("image/")) vista = `<img src="${it.url}" alt="${esc(it.nombre)}">`;
  else if (m.startsWith("video/")) vista = `<video src="${it.url}" controls></video>`;
  else if (m.startsWith("audio/")) vista = `<audio src="${it.url}" controls></audio>`;
  return `${vista}<a href="${it.url}" download="${esc(it.nombre)}">Descargar</a>`;
}
function htmlItem(it) {
  if (it.tipo === "sistema") return `<div class="msg sistema"><span>${esc(it.texto)} · ${hora(it.ts)}</span></div>`;
  if (it.tipo === "texto") return `<div class="msg ${it.mio ? "mio" : ""}"><div class="burbuja">${esc(it.texto)}<span class="hora">${hora(it.ts)}</span></div></div>`;
  const error = ["corrupto", "interrumpido"].includes(it.estado);
  return `<div class="msg ${it.mio ? "mio" : ""}"><div class="burbuja archivo ${error ? "error" : ""}" data-arch="${it.id}">
    <div class="nombre-arch">📎 ${esc(it.nombre)}</div><div class="detalle">${esc(textoEstado(it))}</div>
    <div class="barra"><div style="width:${Math.floor((it.progreso || 0) * 100)}%"></div></div>
    <div class="contenido">${contenidoArchivo(it)}</div><span class="hora">${hora(it.ts)}</span></div></div>`;
}
function actualizarArchivo(it, cambios) {
  const antes = it.url;
  Object.assign(it, cambios);
  const el = document.querySelector(`[data-arch="${it.id}"]`); if (!el) return;
  el.querySelector(".detalle").textContent = textoEstado(it);
  el.querySelector(".barra div").style.width = Math.floor((it.progreso || 0) * 100) + "%";
  el.classList.toggle("error", ["corrupto", "interrumpido"].includes(it.estado));
  if (it.url && it.url !== antes) { el.querySelector(".contenido").innerHTML = contenidoArchivo(it); bajar(); }
}
function enviarTexto() {
  const t = $("texto").value.trim(); const con = S.abierto;
  if (!t || !con) return;
  if (!S.usuarios.get(con)?.conectado) return aviso(`${con} no está conectado`, true);
  senal({ tipo: "chat", para: con, datos: { texto: t } });
  $("texto").value = "";
  agregarItem(con, { tipo: "texto", mio: true, texto: t, ts: Date.now() });
}
function enviarArchivo(archivo) {
  const con = S.abierto; if (!con || !archivo) return;
  if (!S.usuarios.get(con)?.conectado) return aviso(`${con} no está conectado`, true);
  const item = { tipo: "archivo", mio: true, id: Math.random().toString(36).slice(2, 12), nombre: archivo.name, mime: archivo.type, tamano: archivo.size, progreso: 0, estado: "preparando", ts: Date.now(), url: URL.createObjectURL(archivo) };
  agregarItem(con, item);
  obtenerPar(con).enviar(archivo, item);
}

// ------------------------------------------------------------------ directorio y vistas
function pintarLista() {
  const us = [...S.usuarios.entries()].sort((a, b) => (b[1].conectado - a[1].conectado) || a[0].localeCompare(b[0]));
  const enLinea = us.filter(([, u]) => u.conectado).length;
  $("resumen").textContent = `${enLinea} usuario(s) en línea`;
  if (!us.length) { $("lista").innerHTML = `<div class="vacio">Aún no hay nadie más conectado.<br>Abre otra ventana (o una de incógnito) y entra con otro nombre.</div>`; return; }
  $("lista").innerHTML = us.map(([n, u]) => {
    const conv = S.conversaciones.get(n) || []; const ult = conv[conv.length - 1];
    const previa = ult ? (ult.tipo === "texto" ? (ult.mio ? "Tú: " : "") + ult.texto : ult.tipo === "archivo" ? "📎 " + ult.nombre : ult.texto) : (u.conectado ? "en línea" : "desconectado");
    const nl = S.noLeidos.get(n) || 0;
    return `<div class="contacto ${S.abierto === n ? "sel" : ""}" data-u="${esc(n)}">
      <div class="avatar" style="background:${colorDe(n)}">${esc(n[0])}<i class="${u.conectado ? "on" : ""}"></i></div>
      <div class="info"><div class="fila"><span class="nombre">${esc(n)}</span><span class="etiqueta">${esc(u.nodo)}</span></div>
      <div class="fila"><span class="previa">${esc(previa)}</span>${nl ? `<span class="badge">${nl}</span>` : ""}</div></div></div>`;
  }).join("");
}
function pintarCabecera() {
  const u = S.usuarios.get(S.abierto) || {};
  const av = $("chatAvatar"); av.innerHTML = ""; avatar(av, S.abierto, !!u.conectado);
  $("chatNombre").textContent = S.abierto;
  $("chatEstado").textContent = u.conectado ? `en línea · conectado a ${u.nodo}` : "desconectado";
  $("btnLlamar").disabled = !u.conectado || !!S.llamada;
}
function abrirChat(n) {
  S.abierto = n; S.noLeidos.delete(n);
  $("portada").classList.add("oculto"); $("vistaSala").classList.add("oculto"); $("vistaChat").classList.remove("oculto"); $("contenedor").classList.add("con-chat");
  pintarCabecera();
  $("mensajes").innerHTML = (S.conversaciones.get(n) || []).map(htmlItem).join(""); bajar();
  pintarLista(); $("texto").focus();
}
function entrar() {
  $("acceso").classList.add("oculto"); $("app").classList.remove("oculto");
  avatar($("miAvatar"), S.yo); $("miNombre").textContent = S.yo; $("miNodo").textContent = `conectado a ${S.nodo}`;
}

// ------------------------------------------------------------------ salas: videollamada grupal en malla (RETO)
function pintarSalas() {
  const el = $("listaSalas");
  if (!S.salas.length) { el.innerHTML = `<div class="vacio-mini">No hay salas activas. Crea una con «+ Sala».</div>`; return; }
  el.innerHTML = S.salas.map((x) => {
    const nombres = x.miembros.map((m) => m.usuario).join(", ");
    return `<div class="sala-item ${S.sala && S.sala.nombre === x.sala ? "sel" : ""}" data-sala="${esc(x.sala)}">
      <div class="avatar sala-av">#</div><div class="info"><b>${esc(x.sala)}</b>
      <small>${x.miembros.length} participante(s): ${esc(nombres)}${x.presentador ? " · 🖥 " + esc(x.presentador) : ""}</small></div></div>`;
  }).join("");
}
async function unirseSala(nombre) {
  nombre = nombre.trim().toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9_-]/g, "").slice(0, 24);
  if (!nombre) return aviso("Nombre de sala inválido", true);
  if (S.llamada) return aviso("Cuelga la llamada actual antes de entrar a una sala", true);
  if (S.sala && S.sala.nombre === nombre) return mostrarSala();
  if (S.sala) salirSala();
  let local;
  try { local = await obtenerMedios(); } catch (e) { return aviso(e.message, true); }
  S.sala = { nombre, local, camara: local.getVideoTracks()[0] || null, miembros: new Map(), presentador: null, pantalla: null };
  $("mensajesSala").innerHTML = "";
  mostrarSala(); pintarGrupo();
  senal({ tipo: "unirse", sala: nombre });
  mensajeSala(`Entraste a la sala «${nombre}»`);
}
function mostrarSala() {
  S.abierto = null;
  $("portada").classList.add("oculto"); $("vistaChat").classList.add("oculto"); $("vistaSala").classList.remove("oculto");
  $("contenedor").classList.add("con-chat");
  $("salaNombre").textContent = "Sala " + S.sala.nombre;
  pintarLista(); pintarSalas();
}
function agregarMiembro(usuario, nodo) {
  if (!S.sala || usuario === S.yo || S.sala.miembros.has(usuario)) return;
  S.sala.miembros.set(usuario, nodo);
  const p = obtenerPar(usuario);               // una RTCPeerConnection por cada par (malla)
  p.agregarMedios(S.sala.local);
  if (S.sala.pantalla) reemplazarVideo(p, S.sala.pantalla);
}
function quitarMiembro(usuario) {
  if (!S.sala || !S.sala.miembros.has(usuario)) return;
  S.sala.miembros.delete(usuario);
  if (S.sala.presentador === usuario) S.sala.presentador = null;
  const p = S.pares.get(usuario); if (p) p.quitarMedios();
  pintarGrupo(); ajustarBitrate();
}
function pintarGrupo() {
  if (!S.sala) return;
  const g = $("grupo");
  const usuarios = [S.yo, ...S.sala.miembros.keys()];
  // conservar los <video> existentes para no cortar la reproducción
  for (const t of [...g.children]) if (!usuarios.includes(t.dataset.u)) t.remove();
  for (const u of usuarios) {
    if (g.querySelector(`.tile[data-u="${CSS.escape(u)}"]`)) continue;
    const t = document.createElement("div");
    t.className = "tile" + (u === S.yo ? " propio" : ""); t.dataset.u = u;
    const nodo = u === S.yo ? S.nodo : S.sala.miembros.get(u);
    t.innerHTML = `<video autoplay playsinline ${u === S.yo ? "muted" : ""}></video><span class="etq">${esc(u === S.yo ? u + " (tú)" : u)} · ${esc(nodo || "")}</span>${u === S.yo ? "" : '<div class="espera">Conectando…</div>'}`;
    if (u === S.yo) t.querySelector("video").srcObject = S.sala.pantalla ? new MediaStream([S.sala.pantalla]) : S.sala.local;
    else { const p = S.pares.get(u); const r = p && p.pc.getReceivers().map((x) => x.track).filter((x) => x && x.readyState === "live");
      if (r && r.length) { t.querySelector("video").srcObject = new MediaStream(r); t.querySelector(".espera")?.remove(); } }
    g.appendChild(t);
  }
  // distribución: cuadrícula; quien comparte pantalla ocupa la fila superior completa
  const n = usuarios.length, pres = S.sala.presentador;
  for (const t of g.children) { t.classList.toggle("presentando", t.dataset.u === pres); t.classList.toggle("pantalla", t.dataset.u === S.yo && !!S.sala.pantalla); t.style.gridColumn = ""; }
  if (pres && usuarios.includes(pres)) {
    const otros = Math.max(1, n - 1);
    g.style.gridTemplateColumns = `repeat(${otros}, 1fr)`; g.style.gridTemplateRows = n > 1 ? "3fr 1fr" : "1fr";
    const tp = g.querySelector(`.tile[data-u="${CSS.escape(pres)}"]`); g.prepend(tp); tp.style.gridColumn = "1 / -1";
  } else {
    const cols = n <= 1 ? 1 : n <= 4 ? 2 : 3;
    g.style.gridTemplateColumns = `repeat(${cols}, 1fr)`; g.style.gridTemplateRows = "";
  }
  $("salaEstado").textContent = `${n} participante(s) · malla de ${n * (n - 1) / 2} conexión(es)${pres ? " · " + pres + " comparte pantalla" : ""}`;
}
async function ajustarBitrate() {
  // control de ancho de banda: en malla cada uno sube su video n-1 veces
  if (!S.sala) return;
  const n = S.sala.miembros.size;
  const max = S.sala.pantalla ? 1200000 : n <= 1 ? 1000000 : n === 2 ? 600000 : 350000;
  for (const u of S.sala.miembros.keys()) {
    const p = S.pares.get(u); if (!p) continue;
    for (const snd of p.senders) {
      if (!snd.track || snd.track.kind !== "video") continue;
      const prm = snd.getParameters(); if (!prm.encodings || !prm.encodings.length) continue;
      prm.encodings[0].maxBitrate = max;
      try { await snd.setParameters(prm); } catch (e) { /* aún negociando */ }
    }
  }
}
function reemplazarVideo(par, pista) {
  for (const snd of par.senders) if (snd.track && snd.track.kind === "video") snd.replaceTrack(pista).catch(() => {});
  // si ya se cambió antes, el sender conserva el kind "video"
  for (const snd of par.pc.getSenders()) if (par.senders.includes(snd) && !snd.track && pista) snd.replaceTrack(pista).catch(() => {});
}
async function compartirPantalla() {
  if (!S.sala) return;
  if (S.sala.pantalla) return dejarDeCompartir();
  if (S.sala.presentador && S.sala.presentador !== S.yo) return aviso(`${S.sala.presentador} ya está compartiendo pantalla`, true);
  let flujo;
  try { flujo = await navigator.mediaDevices.getDisplayMedia({ video: true }); }   // exige clic del usuario y HTTPS
  catch (e) { return aviso(e.name === "NotAllowedError" ? "Compartir pantalla cancelado o no permitido" : "No se pudo compartir pantalla: " + e.message, true); }
  S.sala.pantallaPendiente = flujo.getVideoTracks()[0];
  S.sala.pantallaPendiente.onended = () => dejarDeCompartir();   // botón "Dejar de compartir" del navegador
  senal({ tipo: "pantalla_sala", sala: S.sala.nombre, datos: { activo: true } });
}
function cancelarPantalla(msg) {
  if (S.sala && S.sala.pantallaPendiente) { S.sala.pantallaPendiente.stop(); S.sala.pantallaPendiente = null; }
  aviso(msg, true);
}
function alCambiarPantalla(quien, activo) {
  if (!S.sala) return;
  S.sala.presentador = activo ? quien : (S.sala.presentador === quien ? null : S.sala.presentador);
  if (quien === S.yo && activo && S.sala.pantallaPendiente) {
    S.sala.pantalla = S.sala.pantallaPendiente; S.sala.pantallaPendiente = null;
    for (const u of S.sala.miembros.keys()) { const p = S.pares.get(u); if (p) reemplazarVideo(p, S.sala.pantalla); }
    const v = document.querySelector(`.tile[data-u="${CSS.escape(S.yo)}"] video`); if (v) v.srcObject = new MediaStream([S.sala.pantalla]);
    $("btnPantalla").textContent = "Dejar de compartir";
    ajustarBitrate();
  }
  if (quien !== S.yo) mensajeSala(activo ? `${quien} está compartiendo pantalla` : `${quien} dejó de compartir`);
  pintarGrupo(); pintarSalas();
}
function dejarDeCompartir() {
  if (!S.sala || !S.sala.pantalla) return;
  const pantalla = S.sala.pantalla; S.sala.pantalla = null;
  pantalla.onended = null; pantalla.stop();
  for (const u of S.sala.miembros.keys()) { const p = S.pares.get(u); if (p && S.sala.camara) reemplazarVideo(p, S.sala.camara); }
  const v = document.querySelector(`.tile[data-u="${CSS.escape(S.yo)}"] video`); if (v) v.srcObject = S.sala.local;
  $("btnPantalla").textContent = "Compartir pantalla";
  senal({ tipo: "pantalla_sala", sala: S.sala.nombre, datos: { activo: false } });
  ajustarBitrate();
}
function salirSala() {
  const sala = S.sala; if (!sala) return;
  if (sala.pantalla) dejarDeCompartir();
  senal({ tipo: "salir", sala: sala.nombre });
  for (const u of sala.miembros.keys()) { const p = S.pares.get(u); if (p) p.quitarMedios(); }
  sala.local.getTracks().forEach((t) => t.stop());
  S.sala = null;
  $("grupo").innerHTML = ""; $("vistaSala").classList.add("oculto"); $("portada").classList.remove("oculto"); $("contenedor").classList.remove("con-chat");
  $("btnPantalla").textContent = "Compartir pantalla";
  $("btnMicSala").classList.remove("apagado"); $("btnCamSala").classList.remove("apagado");
  pintarSalas();
}
function mensajeSala(texto, de) {
  const el = $("mensajesSala");
  el.insertAdjacentHTML("beforeend", de
    ? `<div class="msg ${de === S.yo ? "mio" : ""}"><div class="burbuja"><b>${esc(de)}:</b> ${esc(texto)}<span class="hora">${hora()}</span></div></div>`
    : `<div class="msg sistema"><span>${esc(texto)} · ${hora()}</span></div>`);
  el.scrollTop = el.scrollHeight;
}
function enviarSala() {
  const t = $("textoSala").value.trim(); if (!t || !S.sala) return;
  senal({ tipo: "chat_sala", sala: S.sala.nombre, datos: { texto: t } });
  $("textoSala").value = ""; mensajeSala(t, S.yo);
}
function alternarSala(tipo, boton) {
  if (!S.sala) return;
  const pistas = tipo === "audio" ? S.sala.local.getAudioTracks() : S.sala.local.getVideoTracks();
  if (!pistas.length) return aviso(tipo === "audio" ? "No hay micrófono" : "No hay cámara", true);
  const activo = !pistas[0].enabled; pistas.forEach((t) => (t.enabled = activo)); boton.classList.toggle("apagado", !activo);
}

// ------------------------------------------------------------------ eventos
$("formAcceso").onsubmit = (e) => {
  e.preventDefault();
  const n = $("nombre").value.trim(); if (!n) return;
  $("errorAcceso").textContent = ""; S.yo = n; conectar();
};
$("lista").onclick = (e) => { const c = e.target.closest(".contacto"); if (c) abrirChat(c.dataset.u); };
$("btnVolver").onclick = () => { S.abierto = null; $("contenedor").classList.remove("con-chat"); $("vistaChat").classList.add("oculto"); $("portada").classList.remove("oculto"); pintarLista(); };
$("btnEnviar").onclick = enviarTexto;
$("texto").onkeydown = (e) => { if (e.key === "Enter") enviarTexto(); };
$("btnAdjuntar").onclick = () => $("archivo").click();
$("archivo").onchange = (e) => { for (const f of e.target.files) enviarArchivo(f); e.target.value = ""; };
$("btnLlamar").onclick = llamar;
$("btnColgar").onclick = () => terminarLlamada("Llamada finalizada", true);
$("btnMic").onclick = (e) => alternar("audio", e.currentTarget);
$("btnCam").onclick = (e) => alternar("video", e.currentTarget);
$("btnAceptar").onclick = aceptar;
$("btnRechazar").onclick = () => { const de = S.entrante.de; senal({ tipo: "rechazar", para: de }); cerrarModal(); agregarItem(de, sistema(`Rechazaste la llamada de ${de}`)); };
window.addEventListener("beforeunload", () => { if (S.llamada) senal({ tipo: "colgar", para: S.llamada.con }); if (S.sala) senal({ tipo: "salir", sala: S.sala.nombre }); });
$("btnNuevaSala").onclick = () => { $("modalSala").classList.remove("oculto"); $("nombreSala").value = ""; $("nombreSala").focus(); };
$("btnCancelarSala").onclick = () => $("modalSala").classList.add("oculto");
$("formSala").onsubmit = (e) => { e.preventDefault(); $("modalSala").classList.add("oculto"); unirseSala($("nombreSala").value); };
$("listaSalas").onclick = (e) => { const it = e.target.closest(".sala-item"); if (it) unirseSala(it.dataset.sala); };
$("btnSalirSala").onclick = salirSala;
$("btnPantalla").onclick = compartirPantalla;
$("btnMicSala").onclick = (e) => alternarSala("audio", e.currentTarget);
$("btnCamSala").onclick = (e) => alternarSala("video", e.currentTarget);
$("btnEnviarSala").onclick = enviarSala;
$("textoSala").onkeydown = (e) => { if (e.key === "Enter") enviarSala(); };
$("btnVolverSala").onclick = () => { $("contenedor").classList.remove("con-chat"); };
try { const n = localStorage.getItem("mensajero_nombre"); if (n) $("nombre").value = n; } catch (e) {}

(async () => {
  try {
    const c = await (await fetch(BASE + "config")).json();
    S.nodo = c.nodo; S.ice = c.iceServers;
    $("estadoNodo").innerHTML = `<i class="punto ok"></i>Te atenderá el servidor <b>${esc(c.nodo)}</b>, asignado automáticamente`;
  } catch (e) {
    $("estadoNodo").innerHTML = `<i class="punto mal"></i>No se pudo contactar al nodo`;
  }
  $("acceso").classList.remove("oculto");
})();
