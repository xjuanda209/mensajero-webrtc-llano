/* Mensajero WebRTC - cliente web
 * Señalización: WebSocket con el nodo (/ws). Medios y archivos: WebRTC entre navegadores.
 * Cada contacto con el que se habla tiene un objeto Par (una RTCPeerConnection + un DataChannel).
 */
"use strict";
// La videollamada puede vivir en una ventana flotante aparte (Document Picture-in-Picture):
// las búsquedas en el DOM miran primero la ventana principal y luego la flotante.
let docFlotante = null;
const $ = (id) => document.getElementById(id) || docFlotante?.getElementById(id);
const qs = (sel) => document.querySelector(sel) || docFlotante?.querySelector(sel);
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
  yo: null, nodo: "", ice: [], ws: null, registrado: false, reintentos: 0,
  clave: Math.random().toString(36).slice(2) + Date.now().toString(36),   // identifica esta pestaña al reconectar
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

// ------------------------------------------------------------------ cifrado de extremo a extremo (chat 1:1)
// Cada pestaña crea un par de claves ECDH P-256 (la privada nunca sale del navegador). Para hablar con
// alguien se intercambian las claves PÚBLICAS por el servidor (mensaje "clave"); cada lado deriva la misma
// clave AES-GCM de 256 bits con ECDH + HKDF. El servidor solo reenvía texto cifrado que no puede leer.
// El código de seguridad (12 grupos de 5 cifras) es un hash de ambas claves públicas: si los dos ven el
// mismo código, nadie (ni el servidor) se interpuso cambiando las claves.
const te = new TextEncoder(), td = new TextDecoder();
const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
const deB64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const E2E = { par: null, pub: "", claves: new Map(), esperas: new Map(), verificados: new Set() };
async function iniciarE2E() {
  E2E.par = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]);
  E2E.pub = b64(await crypto.subtle.exportKey("raw", E2E.par.publicKey));
}
async function codigoSeguridad(otro, pubOtro) {
  const partes = [`${S.yo}:${E2E.pub}`, `${otro}:${pubOtro}`].sort().join("|");
  const h = new Uint8Array(await crypto.subtle.digest("SHA-256", te.encode(partes)));
  const grupos = [];
  for (let i = 0; i < 12; i++) grupos.push(String(((h[2 * i] << 8) | h[2 * i + 1]) % 100000).padStart(5, "0"));
  return grupos;
}
async function alClave(de, d) {
  if (!d.pub || !E2E.par) return;
  const previa = E2E.claves.get(de);
  if (!previa || previa.pub !== d.pub) {
    const pubOtro = await crypto.subtle.importKey("raw", deB64(d.pub), { name: "ECDH", namedCurve: "P-256" }, false, []);
    const bits = await crypto.subtle.deriveBits({ name: "ECDH", public: pubOtro }, E2E.par.privateKey, 256);
    const base = await crypto.subtle.importKey("raw", bits, "HKDF", false, ["deriveKey"]);
    const key = await crypto.subtle.deriveKey(
      { name: "HKDF", hash: "SHA-256", salt: te.encode([S.yo, de].sort().join("|")), info: te.encode("mensajero-webrtc chat e2e v1") },
      base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
    E2E.claves.set(de, { pub: d.pub, key, codigo: await codigoSeguridad(de, d.pub) });
    if (previa) { E2E.verificados.delete(de); agregarItem(de, sistema(`El código de seguridad con ${de} cambió (volvió a entrar). Verifícalo de nuevo.`)); }
    else agregarItem(de, sistema("Los mensajes con este contacto están cifrados de extremo a extremo. Toca el candado para ver el código de seguridad."));
    if (S.abierto === de) pintarCabecera();
  }
  if (!d.resp) senal({ tipo: "clave", para: de, datos: { pub: E2E.pub, resp: true } });
  const w = E2E.esperas.get(de); if (w) { E2E.esperas.delete(de); w.forEach((f) => f()); }
}
function claveCon(nombre, ms = 4000) {
  const k = E2E.claves.get(nombre); if (k) return Promise.resolve(k);
  return new Promise((ok) => {
    const lista = E2E.esperas.get(nombre) || []; E2E.esperas.set(nombre, lista);
    const t = setTimeout(() => ok(null), ms);       // el otro no soporta cifrado (p. ej. cliente de consola)
    lista.push(() => { clearTimeout(t); ok(E2E.claves.get(nombre)); });
    if (lista.length === 1) senal({ tipo: "clave", para: nombre, datos: { pub: E2E.pub, resp: false } });
  });
}
async function cifrar(para, texto) {
  const k = await claveCon(para); if (!k) return null;
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: te.encode(`${S.yo}>${para}`) }, k.key, te.encode(texto));
  return { cifrado: b64(ct), iv: b64(iv) };
}
async function descifrar(de, d) {
  const k = E2E.claves.get(de); if (!k) throw new Error("sin clave");
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: deB64(d.iv), additionalData: te.encode(`${de}>${S.yo}`) }, k.key, deB64(d.cifrado));
  return td.decode(pt);
}
let colaRx = Promise.resolve();       // descifra en orden de llegada

// ------------------------------------------------------------------ señalización (WebSocket)
function senal(msg) {
  if (S.ws && S.ws.readyState === WebSocket.OPEN) { S.ws.send(JSON.stringify(msg)); return true; }
  return false;
}
function conectar() {
  // Al reconectar se vuelve al MISMO nodo (/nodoX/ws) para recuperar la sesión;
  // si ese nodo no responde tras 2 intentos, se usa la entrada general (balanceo).
  const ruta = S.registrado && BASE === "/" && S.nodo && S.reintentos < 3 ? `/${S.nodo}/ws` : `${BASE}ws`;
  const ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}${ruta}`);
  S.ws = ws;
  ws.onopen = () => ws.send(JSON.stringify({ tipo: "registro", de: S.yo, datos: { clave: S.clave } }));
  ws.onmessage = (e) => alMensajeServidor(JSON.parse(e.data));
  ws.onclose = () => {
    $("senal").className = "senal mal";
    if (S.ws !== ws) return;                 // ya se abrió otra conexión
    if (S.despedido) return;                 // se está cerrando la ventana
    if (S.registrado) { S.reintentos++; aviso("Se perdió la conexión con el servidor de señalización. Reintentando…", true); setTimeout(conectar, 2000); }
  };
}
function alMensajeServidor(m) {
  const d = m.datos || {};
  switch (m.tipo) {
    case "bienvenida":
      S.registrado = true;
      S.nodo = m.nodo;                       // el nodo real que atiende este WebSocket
      if (S.reintentos) { aviso("Conexión con el servidor recuperada"); S.reintentos = 0; $("miNodo").textContent = `conectado a ${S.nodo}`; }
      if (S.sala) senal({ tipo: "unirse", sala: S.sala.nombre });   // volver a la sala tras reconectar
      $("senal").className = "senal ok";
      for (const u of d.usuarios) if (u.usuario !== S.yo) S.usuarios.set(u.usuario, { nodo: u.nodo, conectado: true });
      S.salas = d.salas || [];
      try { localStorage.setItem("mensajero_nombre", S.yo); } catch (e) {}
      if ($("app").classList.contains("oculto")) entrar();
      pintarLista(); pintarSalas();
      break;
    case "error":
      if (!S.registrado) { $("errorAcceso").textContent = d.motivo; S.yo = null; S.ws.close(); }
      else if (d.motivo === "Nombre vacío o en uso") { setTimeout(() => S.ws.close(), 1500); }   // la sesión vieja aún no se libera: reintentar
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
    case "chat": {
      const ts = Date.now();
      colaRx = colaRx.then(async () => {
        if (!d.cifrado) return agregarItem(m.de, { tipo: "texto", mio: false, texto: d.texto, ts, cifrado: false });
        try { agregarItem(m.de, { tipo: "texto", mio: false, texto: await descifrar(m.de, d), ts, cifrado: true }); }
        catch (e) { agregarItem(m.de, sistema(`No se pudo descifrar un mensaje de ${m.de} (la clave cambió).`)); }
      });
      break;
    }
    case "clave": colaRx = colaRx.then(() => alClave(m.de, d)).catch((e) => console.error(e)); break;
    case "oferta": case "respuesta": {
      // oferta de una conexión rehecha por el otro lado: descartar la nuestra y empezar limpia
      const par = m.tipo === "oferta" && d.nueva ? rehacerPar(m.de, false) : obtenerPar(m.de);
      par.encolar(() => par.alDescripcion(d.descripcion));
      break;
    }
    case "candidato": { const par = obtenerPar(m.de); par.encolar(() => par.alCandidato(d.candidato)); break; }
    case "llamada": if (S.sala) senal({ tipo: "ocupado", para: m.de }); else llamadaEntrante(m.de, !!d.voz); break;
    case "salas": S.salas = d.salas || []; pintarSalas(); conciliarSala(); break;
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
        senal({ tipo: "oferta", para: this.nombre, datos: { descripcion: pc.localDescription.toJSON(), nueva: !!this.nueva } });
        this.nueva = false;
      } catch (e) { console.error("negociación", e); } finally { this.makingOffer = false; }
    };
    pc.onicecandidate = ({ candidate }) => candidate && senal({ tipo: "candidato", para: this.nombre, datos: { candidato: candidate.toJSON() } });
    pc.ontrack = (e) => {
      const flujo0 = e.streams[0] || new MediaStream([e.track]);
      if (S.sala && S.sala.miembros.has(this.nombre)) {
        const v = qs(`.tile[data-u="${CSS.escape(this.nombre)}"] video`);
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
      // Autorrecuperación: si la ruta P2P se cae (red, CPU saturada), reiniciar ICE en lugar de obligar a recargar.
      clearTimeout(this.timerIce);
      if (st === "disconnected") this.timerIce = setTimeout(() => { if (pc.connectionState === "disconnected") pc.restartIce(); }, 3000);
      if (st === "failed") {
        if (!this.reinicioIce) { this.reinicioIce = true; pc.restartIce(); }
        else aviso(`No se pudo establecer la conexión directa con ${this.nombre} (puede requerir TURN).`, true);
      }
      if (st === "connected") this.reinicioIce = false;
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

  agregarMedios(flujo) { for (const t of flujo.getTracks()) { const snd = this.pc.addTrack(t, flujo); snd.__kind = t.kind; this.senders.push(snd); } this.vigilar(); }
  // Vigilante: si tras unos segundos la conexión P2P no llegó a "connected" (p. ej. se perdieron
  // candidatos ICE en un choque de ofertas al entrar varios a la vez), se reinicia ICE: nueva oferta
  // con credenciales nuevas. Lo hace solo el lado "impolite" para no provocar otro choque.
  vigilar(intento = 0) {
    clearTimeout(this.timerVigia);
    this.timerVigia = setTimeout(() => {
      const st = this.pc.connectionState;
      if (st === "connected" || st === "closed" || !this.senders.length || S.pares.get(this.nombre) !== this) return;
      if (this.polite) return this.vigilar(intento);            // el otro lado (impolite) toma la iniciativa
      if (intento === 0 && this.pc.signalingState === "stable") { console.warn("reinicio ICE con", this.nombre, st); this.pc.restartIce(); return this.vigilar(1); }
      if ((this.intentosRehacer || 0) < 3) { console.warn("conexión rehecha con", this.nombre, st); rehacerPar(this.nombre, true); }
      else aviso(`No se logra conexión directa con ${this.nombre}. Puede que su red necesite un servidor TURN.`, true);
    }, 6000);
  }
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
        setTimeout(() => rej(new Error("el otro no confirmó la recepción")), 20000);
      });
      actualizarArchivo(item, { estado: ok ? "enviado" : "corrupto" });
    } catch (e) {
      actualizarArchivo(item, { estado: "interrumpido" });
      const motivo = this.dc.readyState !== "open" ? "el otro extremo cerró la conexión" : e.message;
      aviso(`«${item.nombre}» no se pudo enviar (${motivo}). Puedes reintentar.`, true);
    }
  }

  // ---- recepción
  async alDato(dato) {
    try { await this._alDato(dato); } catch (e) { console.error("canal de datos", e); }
  }
  async _alDato(dato) {
    if (typeof dato !== "string") {
      const r = this.recibiendo; if (!r) return;
      r.partes.push(dato); r.bytes += dato.byteLength;
      actualizarArchivo(r.item, { estado: "recibiendo", progreso: r.bytes / r.meta.tamano });
      return;
    }
    const m = JSON.parse(dato);
    if (m.tipo === "archivo-inicio") {
      if (this.recibiendo) actualizarArchivo(this.recibiendo.item, { estado: "interrumpido" });   // un envío anterior quedó a medias
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
  cerrar() { clearTimeout(this.timerVigia); clearTimeout(this.timerIce); this.quitarMedios(); try { this.dc.close(); } catch (e) {} try { this.pc.close(); } catch (e) {} this.alCerrarCanal(); }
}
function textoConexion(par) {
  if (!S.llamada || S.llamada.con !== par.nombre || S.llamada.estado !== "activa") return;
  const st = par.pc.connectionState;
  const s = Math.floor((Date.now() - S.llamada.inicio) / 1000), dur = `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
  $("estadoLlamada").textContent = st === "connected" ? `${dur} · conexión directa (P2P) cifrada` : st === "disconnected" ? "Reconectando…" : "Conectando…";
}
function obtenerPar(nombre) {
  let p = S.pares.get(nombre);
  if (!p || p.pc.connectionState === "closed" || p.pc.connectionState === "failed") { if (p) p.cerrar(); p = new Par(nombre); S.pares.set(nombre, p); }
  return p;
}
// Último recurso: si una conexión no llega a "connected" ni con reinicio ICE (p. ej. el navegador dejó de
// recolectar candidatos), se descarta y se crea una RTCPeerConnection nueva. La oferta va marcada con
// nueva:true para que el otro lado también descarte la suya en lugar de renegociar sobre la vieja.
function mediosPara(nombre) {
  if (S.sala && S.sala.miembros.has(nombre)) return S.sala.local;
  if (S.llamada && S.llamada.con === nombre && S.llamada.estado === "activa") return S.llamada.local;
  return null;
}
function rehacerPar(nombre, iniciar) {
  const vieja = S.pares.get(nombre); if (vieja) vieja.cerrar();
  const p = new Par(nombre); p.nueva = iniciar; p.intentosRehacer = (vieja?.intentosRehacer || 0) + 1;
  S.pares.set(nombre, p);
  const f = mediosPara(nombre);
  if (f) { p.agregarMedios(f); if (S.sala && S.sala.pantalla && S.sala.miembros.has(nombre)) reemplazarVideo(p, S.sala.pantalla); }
  if (S.sala && S.sala.miembros.has(nombre)) {
    const v = qs(`.tile[data-u="${CSS.escape(nombre)}"]`);
    if (v && !v.querySelector(".espera")) v.insertAdjacentHTML("beforeend", '<div class="espera">Reconectando…</div>');
  }
  return p;
}
function alDesconectarse(nombre) {
  E2E.claves.delete(nombre); E2E.verificados.delete(nombre);   // al volver tendrá claves nuevas
  if (S.sala) quitarMiembro(nombre);                             // por si se perdió el aviso "salio"
  if (S.entrante && S.entrante.de === nombre) cerrarModal();
  if (S.llamada && S.llamada.con === nombre) terminarLlamada(`${nombre} se desconectó`, false);
  const p = S.pares.get(nombre); if (p) { p.cerrar(); S.pares.delete(nombre); }
}

// ------------------------------------------------------------------ videollamada
const VIDEO = { width: { ideal: 640 }, height: { ideal: 480 } };
async function obtenerMedios(soloAudio = false) {
  try {
    const f = await navigator.mediaDevices.getUserMedia({ audio: true, video: soloAudio ? false : VIDEO });
    vigilarCamara(f);
    return f;
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
  const voz = !!S.llamada.voz;
  $("llamada").classList.remove("oculto"); $("llamada").classList.toggle("voz", voz); $("estadoLlamada").textContent = texto;
  const av = $("vozAvatar"); av.innerHTML = ""; avatar(av, S.llamada.con); $("vozNombre").textContent = S.llamada.con;
  $("btnCam").classList.toggle("oculto", voz);
  $("videoLocal").srcObject = S.llamada.local; $("videoRemoto").srcObject = null; $("sinVideo").classList.remove("oculto");
  $("btnMic").classList.remove("apagado"); $("btnCam").classList.remove("apagado"); $("btnLlamar").disabled = true; $("btnVoz").disabled = true;
  clearInterval(S.relojLlamada);
  S.relojLlamada = setInterval(() => { if (S.llamada) textoConexion(obtenerPar(S.llamada.con)); }, 1000);
}
async function llamar(voz = false) {
  const con = S.abierto;
  if (!con || S.llamada) return;
  if (S.sala) return aviso("Sal de la sala para hacer una llamada individual", true);
  if (!S.usuarios.get(con)?.conectado) return aviso(`${con} no está conectado`, true);
  let local;
  try { local = await obtenerMedios(voz); } catch (e) { return aviso(e.message, true); }
  S.llamada = { con, estado: "llamando", local, inicio: 0, voz };
  mostrarLlamada(`Llamando a ${con}…`);
  senal({ tipo: "llamada", para: con, datos: { voz } });
  S.llamada.timer = setTimeout(() => { if (S.llamada && S.llamada.estado === "llamando") terminarLlamada(`${con} no contestó`, true); }, 30000);
}
function llamadaEntrante(de, voz) {
  if (S.llamada || S.entrante) return senal({ tipo: "ocupado", para: de });
  S.entrante = { de, voz, timer: setTimeout(() => { senal({ tipo: "rechazar", para: de, datos: { motivo: "no contestó" } }); cerrarModal(); agregarItem(de, sistema(`Llamada perdida de ${de}`)); }, 30000) };
  const av = $("entranteAvatar"); av.innerHTML = ""; avatar(av, de);
  $("entranteTexto").textContent = voz ? `${de} te está llamando (llamada de voz)` : `${de} te está videollamando`;
  $("modalLlamada").classList.remove("oculto");
}
function cerrarModal() { if (S.entrante) clearTimeout(S.entrante.timer); S.entrante = null; $("modalLlamada").classList.add("oculto"); }
async function aceptar() {
  const { de, voz } = S.entrante; cerrarModal();
  let local;
  try { local = await obtenerMedios(voz); }
  catch (e) { senal({ tipo: "rechazar", para: de, datos: { motivo: "sin cámara/micrófono" } }); return aviso(e.message, true); }
  abrirChat(de);
  S.llamada = { con: de, estado: "activa", local, inicio: Date.now(), voz };
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
  cerrarFlotante(); detener(ll.local); clearInterval(S.relojLlamada);
  const p = S.pares.get(ll.con); if (p) p.quitarMedios();
  S.llamada = null;
  $("llamada").classList.add("oculto"); $("videoRemoto").srcObject = null; $("videoLocal").srcObject = null; $("btnLlamar").disabled = false; $("btnVoz").disabled = false;
  const dur = ll.inicio ? ` · ${Math.round((Date.now() - ll.inicio) / 1000)} s` : "";
  agregarItem(ll.con, sistema(`${ll.voz ? "Llamada de voz" : "Videollamada"}: ${motivo || "finalizada"}${dur}`));
}
function alternar(tipo, boton) {
  if (!S.llamada) return;
  const pistas = tipo === "audio" ? S.llamada.local.getAudioTracks() : S.llamada.local.getVideoTracks();
  if (!pistas.length) return aviso(tipo === "audio" ? "No hay micrófono" : "No hay cámara", true);
  const activo = !pistas[0].enabled;
  pistas.forEach((t) => (t.enabled = activo));
  boton.classList.toggle("apagado", !activo);
}

// Si la cámara se cae (otra ventana la soltó, el controlador se reinició, se desconectó la webcam),
// se vuelve a pedir y se reemplaza la pista en todas las conexiones sin cortar la llamada.
function vigilarCamara(flujo) {
  const v = flujo.getVideoTracks()[0]; if (!v) return;
  v.addEventListener("ended", () => recuperarCamara(flujo, v));
}
async function recuperarCamara(flujo, vieja) {
  const enUso = (S.sala && S.sala.local === flujo) || (S.llamada && S.llamada.local === flujo);
  if (!enUso || vieja.detenidaPorMi) return;
  for (let i = 0; i < 5; i++) {
    try {
      const nueva = (await navigator.mediaDevices.getUserMedia({ video: VIDEO })).getVideoTracks()[0];
      nueva.enabled = vieja.enabled;
      flujo.removeTrack(vieja); flujo.addTrack(nueva); nueva.addEventListener("ended", () => recuperarCamara(flujo, nueva));
      for (const p of S.pares.values()) for (const snd of p.senders) if (snd.track === vieja || (!snd.track && snd.__kind === "video")) snd.replaceTrack(nueva).catch(() => {});
      if (S.sala && S.sala.local === flujo) { S.sala.camara = nueva; if (!S.sala.pantalla) { const t = qs(`.tile[data-u="${CSS.escape(S.yo)}"] video`); if (t) t.srcObject = flujo; } }
      if (S.llamada && S.llamada.local === flujo) $("videoLocal").srcObject = flujo;
      aviso("La cámara se reinició y se recuperó");
      return;
    } catch (e) { await new Promise((r) => setTimeout(r, 1500)); }
  }
  aviso("Se perdió la cámara. Sigues con audio.", true);
}
const detener = (flujo) => flujo.getTracks().forEach((t) => { t.detenidaPorMi = true; t.stop(); });

// ------------------------------------------------------------------ ventana flotante para la cámara
// Saca la videollamada (1:1 o sala) a una ventana aparte que queda encima de las demás aplicaciones,
// así se puede seguir chateando o usar otro programa mientras se ve a los demás.
async function abrirFlotante() {
  if (docFlotante) return cerrarFlotante();
  const enSala = !!S.sala, bloque = enSala ? $("bloqueSala") : $("llamada");
  if (!bloque) return;
  if (!("documentPictureInPicture" in window)) {
    // Navegadores sin la API (Firefox, Safari): ventana flotante estándar solo con el video principal
    const v = enSala ? qs(".tile:not(.propio) video") || qs(".tile video") : $("videoRemoto");
    try { if (v && v.srcObject) return await v.requestPictureInPicture(); } catch (e) {}
    return aviso("Tu navegador no permite ventanas flotantes. Usa Chrome o Edge.", true);
  }
  let w;
  try { w = await documentPictureInPicture.requestWindow({ width: enSala ? 640 : 480, height: enSala ? 420 : 360 }); }
  catch (e) { return aviso("No se pudo abrir la ventana flotante: " + e.message, true); }
  // copiar los estilos de la página
  for (const hoja of document.styleSheets) {
    try { const st = w.document.createElement("style"); st.textContent = [...hoja.cssRules].map((r) => r.cssText).join("\n"); w.document.head.appendChild(st); } catch (e) {}
  }
  w.document.title = "Mensajero WebRTC · cámara";
  w.document.body.className = "cuerpo-flotante";
  const marcador = document.createElement("div"); marcador.className = "marcador-flotante" + (enSala ? "" : " compacto");
  marcador.innerHTML = `<span>La cámara está en una ventana aparte</span><button class="btn verde" type="button">Traer de vuelta</button>`;
  marcador.querySelector("button").onclick = cerrarFlotante;
  bloque.before(marcador);
  w.document.body.append(bloque);
  docFlotante = w.document;
  S.flotante = { w, bloque, marcador };
  bloque.querySelectorAll("video").forEach((v) => v.play().catch(() => {}));   // mover un <video> lo pausa
  $("btnFlotante").textContent = $("btnFlotanteSala").textContent = "Volver a la página";
  w.addEventListener("pagehide", () => devolverFlotante());
}
function devolverFlotante() {
  const f = S.flotante; if (!f) return;
  S.flotante = null; docFlotante = null;
  f.marcador.replaceWith(f.bloque);
  f.bloque.querySelectorAll("video").forEach((v) => v.play().catch(() => {}));
  $("btnFlotante").textContent = $("btnFlotanteSala").textContent = "Ventana aparte";
}
function cerrarFlotante() {
  if (document.pictureInPictureElement) document.exitPictureInPicture().catch(() => {});
  const f = S.flotante; if (!f) return;
  devolverFlotante(); try { f.w.close(); } catch (e) {}
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
  preparando: "Preparando…", conectando: "Conectando…", calculando: "Preparando…",
  enviando: "Enviando", confirmando: "Esperando al otro…", enviado: "Entregado",
  recibiendo: "Recibiendo", recibido: "Recibido",
  corrupto: "Llegó dañado", interrumpido: "No se pudo enviar",
};
const CANDADO = `<svg class="candado" width="11" height="11" viewBox="0 0 24 24" fill="currentColor"><path d="M17 9h-1V7a4 4 0 10-8 0v2H7a2 2 0 00-2 2v9a2 2 0 002 2h10a2 2 0 002-2v-9a2 2 0 00-2-2zm-7-2a2 2 0 114 0v2h-4V7z"/></svg>`;
const extension = (n) => (n.includes(".") ? n.split(".").pop() : "archivo").slice(0, 4).toUpperCase();
function tipoVista(it) {
  const m = it.mime || "", e = extension(it.nombre);
  if (m.startsWith("image/")) return "imagen";
  if (m.startsWith("video/")) return "video";
  if (m.startsWith("audio/")) return "audio";
  if (m === "application/pdf" || e === "PDF") return "pdf";
  return "otro";
}
function colorExt(e) {
  return { PDF: "#e2453c", DOC: "#2b6cd4", DOCX: "#2b6cd4", XLS: "#1e8e3e", XLSX: "#1e8e3e", CSV: "#1e8e3e", PPT: "#d35400", PPTX: "#d35400", ZIP: "#6b7a85", RAR: "#6b7a85", TXT: "#54656f" }[e] || "#7f66ff";
}
const ICONO_BAJAR = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 4v11m0 0l-4-4m4 4l4-4M5 20h14"/></svg>`;
function textoEstado(it) {
  if (["enviando", "recibiendo"].includes(it.estado)) return `${ESTADOS[it.estado]} · ${tamano(Math.floor((it.progreso || 0) * it.tamano))} de ${tamano(it.tamano)}`;
  if (["enviado", "recibido"].includes(it.estado)) return `${tamano(it.tamano)} · ${extension(it.nombre)} · ${ESTADOS[it.estado]} ✓`;
  return `${tamano(it.tamano)} · ${ESTADOS[it.estado] || it.estado}`;
}
function vistaPrevia(it) {
  const t = tipoVista(it), listo = !!it.url && !["corrupto"].includes(it.estado);
  if (t === "imagen") return listo ? `<img class="miniatura" src="${it.url}" alt="${esc(it.nombre)}" data-ver="${it.id}">` : `<div class="miniatura vacia">Imagen · ${tamano(it.tamano)}</div>`;
  if (t === "video" && listo) return `<video class="miniatura" src="${it.url}" controls preload="metadata"></video>`;
  if (t === "audio" && listo) return `<audio src="${it.url}" controls></audio>`;
  if (t === "pdf" && listo) return `<div class="pdf-previa" data-ver="${it.id}"><iframe src="${it.url}#toolbar=0&navpanes=0&view=FitH" title="${esc(it.nombre)}" tabindex="-1"></iframe><span>Toca para abrir</span></div>`;
  return "";
}
function htmlArchivo(it) {
  const e = extension(it.nombre), activo = ["enviando", "recibiendo", "confirmando", "conectando", "preparando", "calculando"].includes(it.estado);
  const error = ["corrupto", "interrumpido"].includes(it.estado);
  const accion = it.url && !error && !it.mio ? `<a class="bajar" href="${it.url}" download="${esc(it.nombre)}" title="Guardar">${ICONO_BAJAR}</a>`
    : error && it.mio && it.archivo ? `<button class="reintentar" data-reint="${it.id}">Reintentar</button>` : "";
  return `${vistaPrevia(it)}
    <div class="ficha"><div class="ext" style="background:${colorExt(e)}">${esc(e)}</div>
      <div class="datos"><div class="nombre-arch" title="${esc(it.nombre)}">${esc(it.nombre)}</div><div class="detalle">${esc(textoEstado(it))}</div></div>${accion}</div>
    <div class="barra ${activo ? "" : "oculto"}"><div style="width:${Math.floor((it.progreso || 0) * 100)}%"></div></div>`;
}
function htmlItem(it) {
  if (it.tipo === "sistema") return `<div class="msg sistema"><span>${esc(it.texto)} · ${hora(it.ts)}</span></div>`;
  if (it.tipo === "texto") return `<div class="msg ${it.mio ? "mio" : ""}"><div class="burbuja">${esc(it.texto)}<span class="hora">${it.cifrado ? CANDADO : ""}${hora(it.ts)}</span></div></div>`;
  const error = ["corrupto", "interrumpido"].includes(it.estado);
  return `<div class="msg ${it.mio ? "mio" : ""}"><div class="burbuja archivo ${error ? "error" : ""}" data-arch="${it.id}">
    <div class="cuerpo-arch">${htmlArchivo(it)}</div><span class="hora">${hora(it.ts)}</span></div></div>`;
}
function actualizarArchivo(it, cambios) {
  const antes = { url: it.url, estado: it.estado };
  Object.assign(it, cambios);
  const el = document.querySelector(`[data-arch="${it.id}"]`); if (!el) return;
  el.classList.toggle("error", ["corrupto", "interrumpido"].includes(it.estado));
  if (it.url !== antes.url || it.estado !== antes.estado) { el.querySelector(".cuerpo-arch").innerHTML = htmlArchivo(it); if (it.url !== antes.url) bajar(); return; }
  el.querySelector(".detalle").textContent = textoEstado(it);
  el.querySelector(".barra div").style.width = Math.floor((it.progreso || 0) * 100) + "%";
}
function buscarItem(id) {
  for (const conv of S.conversaciones.values()) { const it = conv.find((x) => x.id === id); if (it) return it; }
  return null;
}
function abrirVisor(it) {
  const t = tipoVista(it);
  $("visorNombre").textContent = it.nombre; $("visorInfo").textContent = `${tamano(it.tamano)} · ${it.mio ? "enviado" : "recibido de " + S.abierto}`;
  $("visorBajar").href = it.url; $("visorBajar").download = it.nombre;
  $("visorCuerpo").innerHTML = t === "imagen" ? `<img src="${it.url}" alt="">` : `<iframe src="${it.url}" title=""></iframe>`;
  $("visor").classList.remove("oculto");
}
let colaTx = Promise.resolve();       // conserva el orden de los mensajes aunque cifrar sea asíncrono
function enviarTexto() {
  const t = $("texto").value.trim(); const con = S.abierto;
  if (!t || !con) return;
  if (!S.usuarios.get(con)?.conectado) return aviso(`${con} no está conectado`, true);
  $("texto").value = "";
  colaTx = colaTx.then(async () => {
    const sobre = await cifrar(con, t);
    senal({ tipo: "chat", para: con, datos: sobre || { texto: t } });
    agregarItem(con, { tipo: "texto", mio: true, texto: t, ts: Date.now(), cifrado: !!sobre });
    if (!sobre) aviso(`${con} no soporta cifrado: el mensaje se envió sin cifrar`, true);
  }).catch((e) => aviso("No se pudo enviar: " + e.message, true));
}
function enviarArchivo(archivo) {
  const con = S.abierto; if (!con || !archivo) return;
  if (!S.usuarios.get(con)?.conectado) return aviso(`${con} no está conectado`, true);
  const item = { tipo: "archivo", mio: true, id: Math.random().toString(36).slice(2, 12), nombre: archivo.name, mime: archivo.type, tamano: archivo.size, progreso: 0, estado: "preparando", ts: Date.now(), url: URL.createObjectURL(archivo), archivo, para: con };
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
  const k = E2E.claves.get(S.abierto);
  $("chatEstado").innerHTML = (u.conectado ? `en línea · ${esc(u.nodo)}` : "desconectado") +
    (k ? ` · ${CANDADO} ${E2E.verificados.has(S.abierto) ? "verificado" : "cifrado de extremo a extremo"}` : "");
  $("btnLlamar").disabled = $("btnVoz").disabled = !u.conectado || !!S.llamada;
  $("btnSeguridad").classList.toggle("verificado", E2E.verificados.has(S.abierto));
}
function abrirChat(n) {
  S.abierto = n; S.noLeidos.delete(n);
  $("portada").classList.add("oculto"); $("vistaSala").classList.add("oculto"); $("vistaChat").classList.remove("oculto"); $("contenedor").classList.add("con-chat");
  pintarCabecera();
  $("mensajes").innerHTML = (S.conversaciones.get(n) || []).map(htmlItem).join(""); bajar();
  pintarLista(); $("texto").focus();
  if (S.usuarios.get(n)?.conectado) claveCon(n).then(() => S.abierto === n && pintarCabecera());   // negociar el cifrado al abrir
}
async function mostrarSeguridad() {
  const n = S.abierto; if (!n) return;
  const k = await claveCon(n);
  if (!k) return aviso(`${n} no admite cifrado de extremo a extremo (cliente antiguo o de consola)`, true);
  $("segTitulo").textContent = `Código de seguridad con ${n}`;
  $("segCodigo").innerHTML = k.codigo.map((g) => `<span>${g}</span>`).join("");
  $("segEstado").textContent = E2E.verificados.has(n) ? "Ya marcaste este código como verificado." : "";
  $("modalSeguridad").classList.remove("oculto");
}
function entrar() {
  $("franja").classList.add("baja");
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
// Autocorrección: la lista de salas que publica el servidor es la verdad. Si la vista local de la sala
// no coincide (p. ej. tras un corte entre nodos), se agregan/quitan participantes o se vuelve a entrar.
function conciliarSala() {
  if (!S.sala) return;
  clearTimeout(S.timerConciliar);
  S.timerConciliar = setTimeout(() => {          // espera a que se asienten los eventos en vuelo
    if (!S.sala) return;
    const info = S.salas.find((x) => x.sala === S.sala.nombre);
    const enServidor = new Map((info ? info.miembros : []).map((m) => [m.usuario, m.nodo]));
    if (!enServidor.has(S.yo)) { senal({ tipo: "unirse", sala: S.sala.nombre }); return; }
    let cambio = false;
    for (const [u, nodo] of enServidor) if (u !== S.yo && !S.sala.miembros.has(u)) { agregarMiembro(u, nodo); cambio = true; }
    for (const u of [...S.sala.miembros.keys()]) if (!enServidor.has(u)) { quitarMiembro(u); cambio = true; }
    if (cambio) pintarGrupo();
  }, 1500);
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
  const doc = g.ownerDocument;
  for (const u of usuarios) {
    if (g.querySelector(`.tile[data-u="${CSS.escape(u)}"]`)) continue;
    const t = doc.createElement("div");
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
    const v = qs(`.tile[data-u="${CSS.escape(S.yo)}"] video`); if (v) v.srcObject = new MediaStream([S.sala.pantalla]);
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
  const v = qs(`.tile[data-u="${CSS.escape(S.yo)}"] video`); if (v) v.srcObject = S.sala.local;
  $("btnPantalla").textContent = "Compartir pantalla";
  senal({ tipo: "pantalla_sala", sala: S.sala.nombre, datos: { activo: false } });
  ajustarBitrate();
}
function salirSala() {
  const sala = S.sala; if (!sala) return;
  cerrarFlotante();
  if (sala.pantalla) dejarDeCompartir();
  senal({ tipo: "salir", sala: sala.nombre });
  for (const u of sala.miembros.keys()) { const p = S.pares.get(u); if (p) p.quitarMedios(); }
  detener(sala.local);
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
$("formAcceso").onsubmit = async (e) => {
  e.preventDefault();
  const n = $("nombre").value.trim(); if (!n) return;
  $("errorAcceso").textContent = ""; S.yo = n;
  if (!E2E.par) { try { await iniciarE2E(); } catch (err) { console.warn("sin WebCrypto: chat sin cifrar", err); } }
  conectar();
};
$("lista").onclick = (e) => { const c = e.target.closest(".contacto"); if (c) abrirChat(c.dataset.u); };
$("btnVolver").onclick = () => { S.abierto = null; $("contenedor").classList.remove("con-chat"); $("vistaChat").classList.add("oculto"); $("portada").classList.remove("oculto"); pintarLista(); };
$("btnEnviar").onclick = enviarTexto;
$("texto").onkeydown = (e) => { if (e.key === "Enter") enviarTexto(); };
$("btnAdjuntar").onclick = () => $("archivo").click();
$("archivo").onchange = (e) => { for (const f of e.target.files) enviarArchivo(f); e.target.value = ""; };
$("btnLlamar").onclick = () => llamar(false);
$("btnVoz").onclick = () => llamar(true);
$("btnFlotante").onclick = abrirFlotante;
$("btnFlotanteSala").onclick = abrirFlotante;
$("btnSeguridad").onclick = mostrarSeguridad;
$("segCerrar").onclick = () => $("modalSeguridad").classList.add("oculto");
$("segVerificar").onclick = () => { E2E.verificados.add(S.abierto); $("modalSeguridad").classList.add("oculto"); agregarItem(S.abierto, sistema(`Marcaste como verificado el código de seguridad con ${S.abierto}.`)); pintarCabecera(); };
$("mensajes").onclick = (e) => {
  const ver = e.target.closest("[data-ver]"); if (ver) { const it = buscarItem(ver.dataset.ver); if (it && it.url) abrirVisor(it); return; }
  const r = e.target.closest("[data-reint]");
  if (r) {
    const it = buscarItem(r.dataset.reint); if (!it || !it.archivo) return;
    if (!S.usuarios.get(it.para)?.conectado) return aviso(`${it.para} no está conectado`, true);
    const el = document.querySelector(`[data-arch="${it.id}"]`);
    it.id = Math.random().toString(36).slice(2, 12); if (el) el.dataset.arch = it.id;   // id nuevo: el receptor lo trata como envío nuevo
    actualizarArchivo(it, { estado: "preparando", progreso: 0 });
    const p = S.pares.get(it.para);
    if (p && p.dc.readyState !== "open") { p.cerrar(); S.pares.delete(it.para); }   // canal muerto: empezar de cero
    obtenerPar(it.para).enviar(it.archivo, it);
  }
};
$("visorCerrar").onclick = () => { $("visor").classList.add("oculto"); $("visorCuerpo").innerHTML = ""; };
$("visor").onclick = (e) => { if (e.target.id === "visor") $("visorCerrar").click(); };
$("btnColgar").onclick = () => terminarLlamada("Llamada finalizada", true);
$("btnMic").onclick = (e) => alternar("audio", e.currentTarget);
$("btnCam").onclick = (e) => alternar("video", e.currentTarget);
$("btnAceptar").onclick = aceptar;
$("btnRechazar").onclick = () => { const de = S.entrante.de; senal({ tipo: "rechazar", para: de }); cerrarModal(); agregarItem(de, sistema(`Rechazaste la llamada de ${de}`)); };
// Cerrar la ventana sin "Salir": avisar al servidor y cerrar las conexiones P2P de inmediato
// para que los demás no se queden esperando video de alguien que ya no está.
function despedirse() {
  if (S.despedido) return; S.despedido = true;
  if (S.llamada) senal({ tipo: "colgar", para: S.llamada.con });
  if (S.sala) senal({ tipo: "salir", sala: S.sala.nombre });
  for (const p of S.pares.values()) { try { p.pc.close(); } catch (e) {} }
  try { S.ws && S.ws.close(1000, "cierre de ventana"); } catch (e) {}
}
window.addEventListener("pagehide", despedirse);
window.addEventListener("beforeunload", despedirse);
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
    $("estadoNodo").innerHTML = BASE === "/"
      ? `<i class="punto ok"></i>Servidores en línea · se te asignará el nodo con menos usuarios`
      : `<i class="punto ok"></i>Entrada directa al servidor <b>${esc(c.nodo)}</b>`;
  } catch (e) {
    $("estadoNodo").innerHTML = `<i class="punto mal"></i>No se pudo contactar al nodo`;
  }
  $("acceso").classList.remove("oculto");
})();
