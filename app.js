/* Cuentas de la Camioneta: app instalable. Los datos viven en una hoja de Google (google-apps-script/Codigo.gs);
   el teléfono guarda una copia para abrir sin internet y una cola de cambios pendientes de enviar. */
const $ = s => document.querySelector(s);
const CFG = window.CAMIONETA_CONFIG || {};
const ES_LOCAL = /^(localhost|127\.0\.0\.1)$/.test(location.hostname);
const API = ES_LOCAL ? '/api-prueba' : (CFG.apiUrl || '');

const fmt = new Intl.NumberFormat("es-MX", { style: "currency", currency: "MXN" });
const fechaLarga = new Intl.DateTimeFormat("es-MX", { weekday: "long", day: "numeric", month: "long", year: "numeric" });
const fechaCorta = new Intl.DateTimeFormat("es-MX", { day: "numeric", month: "short" });
const horaCorta = new Intl.DateTimeFormat("es-MX", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });
const kmFmt = new Intl.NumberFormat("es-MX");
const fmt0 = new Intl.NumberFormat("es-MX", { style: "currency", currency: "MXN", maximumFractionDigits: 0 });
const diaCorto = new Intl.DateTimeFormat("es-MX", { weekday: "short", day: "numeric" });
const mesLargo = new Intl.DateTimeFormat("es-MX", { month: "long", year: "numeric" });
const AYUDA = {
  ingreso: "Dinero que entró a la caja: la cuenta del día, un viaje especial, etc.",
  gasto: "Lo que se pagó: diésel, refacciones, sueldo, etc. Si lo pagó el dueño de su bolsa, márcalo abajo.",
  adeudo: "Cuando el chofer no entregó la cuenta o la entregó incompleta. Lo que sí entregó se suma al saldo y la diferencia queda como deuda del chofer.",
  abono: "Cuando el chofer paga (todo o una parte) de lo que debe. Se suma al saldo y baja su deuda.",
  reparacion: "Reparación o servicio de la camioneta. Queda en la relación de reparaciones y, si se pagó de la caja, se resta del saldo.",
  reembolso: "Dinero que sale de la caja para devolverle al dueño lo que pagó de su bolsa. Se resta del saldo y baja lo que falta por recuperar."
};
const AYUDA_PAGO = {
  caja: "Se resta del saldo disponible.",
  dueno: "No se resta del saldo. Queda en Mis pagos para que el dueño lo recupere después de las cuentas.",
  otro: "No se resta del saldo y no queda pendiente de recuperar."
};
// Saldo: entradas y pagos de deuda suman; gastos y reparaciones pagadas de la caja restan; las deudas no tocan el saldo hasta que se pagan.
// Lo que el dueño paga de su bolsa no sale de la caja; sale hasta que lo recupera (reembolso).
const ENTRA = t => t === "ingreso" || t === "abono";
const DEL_DUENO = m => (m.tipo === "gasto" || m.tipo === "reparacion") && m.pagoDueno === true;
const SALE = m => !DEL_DUENO(m) && (m.tipo === "gasto" || m.tipo === "reembolso" || (m.tipo === "reparacion" && m.deCaja !== false));

/* ---------- almacenamiento local ---------- */
const LS = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
  del(k) { try { localStorage.removeItem(k); } catch {} }
};
let sesion = LS.get("cam-sesion", null);        // {token, usuario, rol}
let servidor = LS.get("cam-datos", []);         // última copia confirmada por la hoja de Google
let cola = LS.get("cam-cola", []);              // cambios aún no enviados
let actualizado = LS.get("cam-actualizado", null);
let avisos = LS.get("cam-avisos", []);          // lo que registró el administrador (solo le llega al dueño)
let movs = [];
let periodo = "mes", tipo = "ingreso", pagoCon = "caja", editId = null, borrando = null, repTodas = false;
let modoBal = "semana", paso = 0;               // paso: 0 = la semana o el mes actual, -1 = el anterior, etc.
let rangoDesde = hoyISO(new Date(Date.now() - 29 * 864e5)), rangoHasta = hoyISO();
let enviando = false, sinConexion = false, errorSync = "";

function hoyISO(d = new Date()) {
  const z = n => String(n).padStart(2, "0");
  return d.getFullYear() + "-" + z(d.getMonth() + 1) + "-" + z(d.getDate());
}
function parseISO(s) { const [y, m, d] = s.split("-").map(Number); return new Date(y, m - 1, d); }
const r2 = n => Math.round(n * 100) / 100;
const limpio = s => s.trim().replace(/\s+/g, " ");
const clave = s => limpio(s || "").toLowerCase();
const num = id => { const v = parseFloat($(id).value); return isNaN(v) ? NaN : r2(v); };
const nuevoId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

/* ---------- datos ---------- */
function normalizar(m) {
  const o = { ...m };
  for (const k of ["monto", "km", "esperado", "entregado"]) o[k] = o[k] === "" || o[k] == null ? undefined : Number(o[k]);
  o.deCaja = !(o.deCaja === false || o.deCaja === "false" || o.deCaja === "FALSE");
  o.pagoDueno = o.pagoDueno === true || o.pagoDueno === "true" || o.pagoDueno === "TRUE";
  for (const k of Object.keys(o)) if (o[k] === "" || o[k] === undefined) delete o[k];
  return o;
}
function aplicarOp(lista, op) {
  if (op.tipo === "mov.guardar") {
    const i = lista.findIndex(m => m.id === op.mov.id);
    const previo = i >= 0 ? lista[i] : null;
    const m = normalizar({ ...op.mov, autor: previo ? previo.autor : (sesion && sesion.usuario), creado: previo ? previo.creado : op.mov.creado });
    if (i >= 0) lista[i] = m; else lista.push(m);
  } else if (op.tipo === "mov.borrar") {
    const i = lista.findIndex(m => m.id === op.id);
    if (i >= 0) lista.splice(i, 1);
  }
  return lista;
}
function recalcular() {
  movs = cola.reduce(aplicarOp, servidor.map(normalizar))
    .filter(m => typeof m.monto === "number" && !isNaN(m.monto) && typeof m.fecha === "string")
    .sort((a, b) => b.fecha.localeCompare(a.fecha) || String(b.creado || "").localeCompare(String(a.creado || "")));
}
function cambiar(ops) {
  cola.push(...ops); LS.set("cam-cola", cola);
  recalcular(); llenarSugerencias(); render();
  enviar();
}

/* ---------- comunicación con la hoja de Google ---------- */
async function api(cuerpo) {
  if (!API) throw Object.assign(new Error("La app aún no está conectada a la hoja de Google (falta la URL en config.js)."), { config: true });
  let r;
  try { r = await fetch(API, { method: "POST", body: JSON.stringify(cuerpo) }); }
  catch { throw Object.assign(new Error("Sin conexión a internet."), { red: true }); }
  let j;
  try { j = await r.json(); } catch { throw Object.assign(new Error("Respuesta inesperada del servidor."), { red: true }); }
  if (!j.ok) throw Object.assign(new Error(j.error || "Error del servidor"), { auth: !!j.auth, necesitaCodigo: !!j.necesitaCodigo });
  return j;
}
function recibir(j) {
  if (j.avisos) recibirAvisos(j.avisos);
  servidor = j.movimientos || [];
  actualizado = new Date().toISOString();
  LS.set("cam-datos", servidor); LS.set("cam-actualizado", actualizado);
}
async function enviar() {
  if (enviando || !sesion) return;
  enviando = true; pintarEstado();
  try {
    if (cola.length) {
      const ops = cola.slice();
      const j = await api({ accion: "ops", token: sesion.token, ops });
      cola = cola.slice(ops.length); LS.set("cam-cola", cola);
      recibir(j);
    } else {
      recibir(await api({ accion: "datos", token: sesion.token }));
    }
    sinConexion = false; errorSync = "";
  } catch (e) {
    if (e.auth) { enviando = false; return salir("Tu sesión expiró. Vuelve a iniciar sesión.", true); }
    if (e.red) sinConexion = true;
    else {
      errorSync = e.message;
      // un cambio que la hoja rechaza no debe bloquear a los demás para siempre
      if (cola.length && !e.config) { cola.shift(); LS.set("cam-cola", cola); }
    }
  } finally {
    enviando = false;
    recalcular(); llenarSugerencias(); render();
    if (cola.length && !sinConexion && !errorSync) setTimeout(enviar, 300);
  }
}
window.addEventListener("online", () => { sinConexion = false; enviar(); });
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") enviar(); });
setInterval(() => { if (document.visibilityState === "visible") enviar(); }, 60000);

function pintarEstado() {
  const e = $("#estado"); if (!e) return;
  e.textContent = "";
  const t = document.createElement("span");
  if (enviando) t.textContent = "Actualizando…";
  else if (cola.length) { t.className = "pend"; t.textContent = cola.length + (cola.length === 1 ? " cambio pendiente de enviar" : " cambios pendientes de enviar") + (sinConexion ? " (sin conexión)" : ""); }
  else if (sinConexion) t.textContent = "Sin conexión. Datos del " + (actualizado ? horaCorta.format(new Date(actualizado)) : "—");
  else t.textContent = actualizado ? "Actualizado " + horaCorta.format(new Date(actualizado)) : "";
  e.append(t);
  if (errorSync) { const er = document.createElement("span"); er.className = "pend"; er.textContent = errorSync; e.append(er); }
  if (!enviando) { const b = document.createElement("button"); b.type = "button"; b.textContent = "Actualizar"; b.onclick = () => { errorSync = ""; enviar(); }; e.append(b); }
}

/* ---------- formulario ---------- */
function llenarDatalist(sel, valores) {
  const dl = $(sel); dl.textContent = "";
  for (const n of valores.slice(0, 40)) { const o = document.createElement("option"); o.value = n; dl.append(o); }
}
function llenarSugerencias() {
  llenarDatalist("#conceptosUsados", [...new Set(movs.filter(m => m.tipo === tipo).map(m => m.categoria).filter(Boolean))]);
  const vistos = new Map();
  for (const m of movs) if (m.chofer && !vistos.has(clave(m.chofer))) vistos.set(clave(m.chofer), m.chofer);
  llenarDatalist("#choferesUsados", [...vistos.values()]);
  llenarDatalist("#talleresUsados", [...new Set(movs.map(m => m.taller).filter(Boolean))]);
}

// Muestra los campos que corresponden a cada tipo
function ponerTipo(t, sel) {
  tipo = t;
  document.querySelectorAll(".tipo button").forEach(b => b.setAttribute("aria-pressed", String(b.dataset.v === t)));
  if (sel !== undefined) $("#categoria").value = sel;
  const conChofer = t === "adeudo" || t === "abono";
  const cuentaNueva = t === "adeudo" && !editId;
  $("#fChofer").hidden = !conChofer;
  $("#fCuenta").hidden = !cuentaNueva;
  $("#fMonto").hidden = cuentaNueva;
  $("#lblMonto").textContent = t === "adeudo" ? "Monto de la deuda" : t === "abono" ? "Cuánto pagó" : t === "reembolso" ? "Cuánto se recupera" : "Monto (MXN)";
  $("#fTaller").hidden = t !== "reparacion";
  $("#fPago").hidden = t !== "gasto" && t !== "reparacion";
  ponerPago(pagoCon);
  $("#lblConcepto").textContent = conChofer || t === "reembolso" ? "Concepto (opcional)" : t === "reparacion" ? "Qué se reparó o qué servicio se hizo" : "Concepto";
  $("#categoria").placeholder = t === "adeudo" ? "Cuenta del día" : t === "abono" ? "Pago de deuda" : t === "reembolso" ? "Recuperación del dueño"
    : t === "reparacion" ? "Ej. Cambio de balatas, afinación, clutch" : "Ej. Cuenta del día, Diésel, Cambio de aceite";
  $("#ayuda").textContent = AYUDA[t];
  actualizarCalc();
  llenarSugerencias();
}

// ¿Con qué se pagó? (gastos y reparaciones). "Otro" solo existe para reparaciones.
function ponerPago(v) {
  if (v === "otro" && tipo !== "reparacion") v = "caja";
  pagoCon = v;
  $('#pago [data-v="otro"]').hidden = tipo !== "reparacion";
  document.querySelectorAll("#pago button").forEach(b => b.setAttribute("aria-pressed", String(b.dataset.v === v)));
  $("#pagoAyuda").textContent = AYUDA_PAGO[v];
}

function actualizarCalc() {
  const c = $("#calc");
  if (tipo !== "adeudo" || editId) { c.hidden = true; return; }
  const e = num("#esperado"), d = isNaN(num("#entregado")) ? 0 : num("#entregado");
  if (!(e > 0)) { c.hidden = true; return; }
  c.hidden = false; c.textContent = "";
  const parte = (t, v, cls) => { const s = document.createElement("span"); s.textContent = t + " "; const b = document.createElement("b"); b.className = cls; b.textContent = fmt.format(v); s.append(b); c.append(s); };
  if (d >= e) { c.textContent = "Entregó la cuenta completa: regístrala como Entrada."; return; }
  parte("Entra a caja", d, "in");
  parte("Queda a deber", r2(e - d), "debe");
}

function enPeriodo(f) {
  if (periodo === "todo") return true;
  const hoy = hoyISO();
  if (periodo === "hoy") return f === hoy;
  if (periodo === "mes") return f.slice(0, 7) === hoy.slice(0, 7);
  const d = new Date(); d.setDate(d.getDate() - 6);
  return f >= hoyISO(d) && f <= hoy;
}

/* ---------- vistas ---------- */
function calcularDeudas() {
  const porChofer = new Map();
  for (const m of movs) {
    if ((m.tipo !== "adeudo" && m.tipo !== "abono") || !m.chofer) continue;
    const k = clave(m.chofer);
    if (!porChofer.has(k)) porChofer.set(k, { nombre: m.chofer, debe: 0, pago: 0 });
    const c = porChofer.get(k);
    m.tipo === "adeudo" ? c.debe += m.monto : c.pago += m.monto;
  }
  return [...porChofer.values()].map(c => ({ ...c, pendiente: r2(c.debe - c.pago) }))
    .sort((a, b) => b.pendiente - a.pendiente);
}

function renderDeudas(lista) {
  const cont = $("#deudas"); cont.textContent = "";
  const conSaldo = lista.filter(c => c.pendiente !== 0);
  if (!conSaldo.length) {
    const p = document.createElement("p"); p.className = "vacio";
    p.textContent = lista.length ? "Ningún chofer debe nada." : "Sin deudas. Si un chofer no entrega la cuenta completa, regístralo como Deuda de chofer.";
    cont.append(p); return;
  }
  for (const c of conSaldo) {
    const row = document.createElement("div"); row.className = "chofer";
    const tx = document.createElement("div");
    const nm = document.createElement("div"); nm.className = "nm"; nm.textContent = c.nombre;
    const det = document.createElement("div"); det.className = "det num";
    det.textContent = "Debió " + fmt.format(c.debe) + " · pagó " + fmt.format(c.pago);
    tx.append(nm, det);
    const der = document.createElement("div"); der.className = "der";
    const m = document.createElement("span"); m.className = "m " + (c.pendiente > 0 ? "debe" : "in");
    m.textContent = c.pendiente > 0 ? fmt.format(c.pendiente) : fmt.format(-c.pendiente) + " a favor";
    der.append(m);
    if (c.pendiente > 0) {
      const b = document.createElement("button"); b.type = "button"; b.className = "btn sec chico"; b.textContent = "Registrar pago";
      b.onclick = () => {
        limpiar(); ponerTipo("abono", "");
        $("#chofer").value = c.nombre; $("#monto").value = c.pendiente; msg("");
        irA("registros");
        $("#captura").scrollIntoView({ behavior: "smooth", block: "start" }); $("#monto").focus({ preventScroll: true });
      };
      der.append(b);
    }
    row.append(tx, der); cont.append(row);
  }
}

/* ---------- balance por semana, mes o fechas elegidas ---------- */
function lunesDe(d) { const x = new Date(d.getFullYear(), d.getMonth(), d.getDate()); x.setDate(x.getDate() - (x.getDay() + 6) % 7); return x; }
function masDias(d, n) { const x = new Date(d); x.setDate(x.getDate() + n); return x; }
const diasEntre = (a, b) => Math.round((b - a) / 864e5);
const may = s => s.charAt(0).toUpperCase() + s.slice(1);
const mesAbrev = d => fechaCorta.format(d).replace(/^\d+\s*(de\s*)?/, "").replace(".", "");
function rangoTxt(a, z) {
  const anio = z.getFullYear() !== new Date().getFullYear() || a.getFullYear() !== z.getFullYear() ? " " + z.getFullYear() : "";
  return a.getDate() + (a.getMonth() === z.getMonth() && a.getFullYear() === z.getFullYear() ? "" : " " + mesAbrev(a)) + " – " + z.getDate() + " " + mesAbrev(z) + anio;
}

// Rango que se está viendo: la semana o el mes desplazado `paso` veces hacia atrás, o las fechas elegidas
function rangoBal() {
  const hoy = parseISO(hoyISO());
  if (modoBal === "semana") { const l = masDias(lunesDe(hoy), paso * 7); return { desde: l, hasta: masDias(l, 6) }; }
  if (modoBal === "mes") { const d = new Date(hoy.getFullYear(), hoy.getMonth() + paso, 1); return { desde: d, hasta: new Date(d.getFullYear(), d.getMonth() + 1, 0) }; }
  return { desde: parseISO(rangoDesde), hasta: parseISO(rangoHasta) };
}

// Parte el rango en renglones: días, semanas (cortadas en lunes), meses o uno solo
function partir(desde, hasta, unidad) {
  const g = [];
  for (let d = desde; d <= hasta;) {
    let fin = unidad === "dia" ? d
      : unidad === "semana" ? masDias(d, 6 - (d.getDay() + 6) % 7)
      : unidad === "mes" ? new Date(d.getFullYear(), d.getMonth() + 1, 0) : hasta;
    if (fin > hasta) fin = hasta;
    g.push({ desde: d, hasta: fin, a: hoyISO(d), z: hoyISO(fin), entregado: 0, gastos: 0, deuda: 0, abonos: 0 });
    d = masDias(fin, 1);
  }
  return g;
}

function balance(desde, hasta, unidad) {
  const a = hoyISO(desde), z = hoyISO(hasta);
  const b = { entregado: 0, gastos: 0, deuda: 0, abonos: 0, dueno: 0, choferes: new Map(), porCat: {}, grupos: partir(desde, hasta, unidad) };
  for (const m of movs) {
    if (m.fecha < a || m.fecha > z) continue;
    const g = b.grupos.find(x => m.fecha <= x.z);
    if (m.tipo === "ingreso") { b.entregado += m.monto; g.entregado += m.monto; }
    else if (m.tipo === "abono") { b.abonos += m.monto; g.abonos += m.monto; }
    else if (SALE(m)) {
      b.gastos += m.monto; g.gastos += m.monto;
      // Todas las reparaciones se agrupan en una sola barra para comparar contra los demás gastos
      const k = m.tipo === "reparacion" ? "~reparaciones" : m.tipo === "reembolso" ? "~reembolsos" : (clave(m.categoria) || "sin concepto");
      if (!b.porCat[k]) b.porCat[k] = { n: m.tipo === "reparacion" ? "Reparaciones" : m.tipo === "reembolso" ? "Recuperado por el dueño" : (m.categoria || "Sin concepto"), v: 0 };
      b.porCat[k].v += m.monto;
    }
    else if (DEL_DUENO(m)) b.dueno += m.monto;
    else if (m.tipo === "adeudo") {
      b.deuda += m.monto; g.deuda += m.monto;
      const k = clave(m.chofer);
      if (!b.choferes.has(k)) b.choferes.set(k, { nombre: m.chofer || "Sin nombre", v: 0, veces: 0 });
      const c = b.choferes.get(k); c.v += m.monto; c.veces++;
    }
  }
  b.neto = r2(b.entregado + b.abonos - b.gastos);
  return b;
}

function etiqueta(g, unidad) {
  if (unidad === "dia") return diaCorto.format(g.desde);
  if (unidad === "mes") return may(mesAbrev(g.desde)) + " " + String(g.desde.getFullYear()).slice(2);
  return rangoTxt(g.desde, g.hasta);
}

// Fila de una tabla hecha con div: celdas de texto y una clase opcional por celda
function filaTabla(celdas, cls) {
  const r = document.createElement("div"); r.className = "fila-t " + (cls || "");
  for (const [t, c] of celdas) { const s = document.createElement("span"); s.textContent = t; if (c) s.className = c; r.append(s); }
  return r;
}
const cant = (v, c) => v ? [fmt0.format(v), c] : ["—", "nada"];
// lo entregado incluye los pagos de deuda para que las tablas cuadren con el balance
const celdas = (t, x) => [[t], cant(x.entregado + x.abonos, "in"), cant(x.gastos, "out"), cant(x.deuda, "debe")];

function renderBalance() {
  const { desde, hasta } = rangoBal();
  const n = diasEntre(desde, hasta) + 1;
  const unidad = modoBal === "semana" ? "dia" : modoBal === "mes" ? "semana" : n <= 31 ? "dia" : n <= 120 ? "semana" : "mes";
  const b = balance(desde, hasta, unidad);
  document.querySelectorAll("#balModo button").forEach(x => x.setAttribute("aria-pressed", String(x.dataset.v === modoBal)));
  $("#semNav").hidden = modoBal === "rango";
  $("#balFechas").hidden = modoBal !== "rango";
  $("#balDesde").value = rangoDesde; $("#balHasta").value = rangoHasta;
  $("#semNombre").textContent = modoBal === "mes" ? may(mesLargo.format(desde).replace(" de ", " "))
    : paso === 0 ? "Esta semana" : paso === -1 ? "Semana pasada" : "Hace " + -paso + " semanas";
  $("#semRango").textContent = rangoTxt(desde, hasta) + (modoBal === "rango" ? " · " + n + (n === 1 ? " día" : " días") : "");
  $("#semSig").disabled = paso >= 0;
  $("#sIn").textContent = fmt.format(b.entregado + b.abonos);
  $("#sOut").textContent = fmt.format(b.gastos);
  $("#sDebe").textContent = fmt.format(b.deuda);
  $("#sNetoTit").textContent = modoBal === "semana" ? "Balance de la semana" : modoBal === "mes" ? "Balance del mes" : "Balance del periodo";
  $("#sNeto").textContent = (b.neto > 0 ? "+" : "") + fmt.format(b.neto);
  $("#sNeto").className = "num " + (b.neto < 0 ? "out" : "in");
  $("#sDetalle").textContent = (b.abonos ? "Cuentas " + fmt.format(b.entregado) + " + pagos de deuda " + fmt.format(b.abonos) : "Entregado " + fmt.format(b.entregado))
    + " − gastos " + fmt.format(b.gastos) + (b.dueno ? ". Aparte, el dueño pagó " + fmt.format(b.dueno) + " de su bolsa." : "");

  const cats = Object.values(b.porCat).sort((a, c) => c.v - a.v);
  const bars = $("#bars"); bars.textContent = "";
  $("#barsWrap").hidden = !cats.length;
  const max = cats.length ? cats[0].v : 1;
  for (const { n, v } of cats) {
    const r = document.createElement("div"); r.className = "bar";
    const nm = document.createElement("span"); nm.className = "nm"; nm.textContent = n; nm.title = n;
    const tr = document.createElement("span"); tr.className = "tr";
    const i = document.createElement("i"); i.style.width = Math.max(2, v / max * 100) + "%"; tr.append(i);
    const vv = document.createElement("span"); vv.className = "v"; vv.textContent = fmt.format(v);
    r.append(nm, tr, vv); bars.append(r);
  }

  const hoy = hoyISO();
  const tabla = $("#sDias"); tabla.textContent = "";
  tabla.append(filaTabla([[{ dia: "Día", semana: "Semana", mes: "Mes" }[unidad]], ["Entregado"], ["Gastos"], ["Deuda"]], "enc"));
  for (const g of b.grupos) {
    const r = filaTabla(celdas(etiqueta(g, unidad), g), (unidad === "dia" && g.a === hoy ? "hoy" : "") + (g.a > hoy ? " futuro" : ""));
    if (g.abonos) r.title = "Incluye " + fmt.format(g.abonos) + " de pagos de deuda";
    tabla.append(r);
  }
  tabla.append(filaTabla(celdas("Total", b), "total"));

  const ch = [...b.choferes.values()].sort((a, c) => c.v - a.v);
  $("#sChoferesWrap").hidden = !ch.length;
  const lc = $("#sChoferes"); lc.textContent = "";
  for (const c of ch) lc.append(filaTabla([[c.nombre], [c.veces === 1 ? "1 vez" : c.veces + " veces", "nada"], [fmt0.format(c.v), "debe"]], "chof"));

  // Comparación con los periodos anteriores (no aplica a fechas elegidas)
  $("#sHistWrap").hidden = modoBal === "rango";
  if (modoBal === "rango") return;
  const cuantos = modoBal === "semana" ? 8 : 6;
  $("#sHistTit").textContent = modoBal === "semana" ? "Últimas 8 semanas" : "Últimos 6 meses";
  const hist = $("#sHist"); hist.textContent = "";
  hist.append(filaTabla([[modoBal === "semana" ? "Semana" : "Mes"], ["Entregado"], ["Gastos"], ["Deuda"]], "enc"));
  const pasoVisto = paso;
  for (let i = 0; i > -cuantos; i--) {
    paso = i; const r0 = rangoBal(); paso = pasoVisto;
    const nombre = modoBal === "semana" ? fechaCorta.format(r0.desde) : may(mesAbrev(r0.desde)) + " " + String(r0.desde.getFullYear()).slice(2);
    const r = filaTabla(celdas(nombre, balance(r0.desde, r0.hasta, "todo")), i === paso ? "sel" : "");
    r.tabIndex = 0; r.setAttribute("role", "button");
    r.setAttribute("aria-label", "Ver " + (modoBal === "semana" ? "la semana del " : "el mes de ") + nombre);
    const ir = () => { paso = i; renderBalance(); $("#semanal").scrollIntoView({ behavior: "smooth", block: "start" }); };
    r.onclick = ir; r.onkeydown = e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); ir(); } };
    hist.append(r);
  }
}

/* ---------- lo que pagó el dueño de su bolsa y lo que ha recuperado ---------- */
function calcularDueno() {
  let pagado = 0, recuperado = 0;
  for (const m of movs) { if (DEL_DUENO(m)) pagado += m.monto; else if (m.tipo === "reembolso") recuperado += m.monto; }
  return { pagado: r2(pagado), recuperado: r2(recuperado), pendiente: r2(pagado - recuperado) };
}
function renderPagos(d) {
  $("#pgPagado").textContent = fmt.format(d.pagado);
  $("#pgRecup").textContent = fmt.format(d.recuperado);
  $("#pgPend").textContent = fmt.format(Math.max(0, d.pendiente));
  $("#pgRecuperar").disabled = d.pendiente <= 0;
  const items = movs.filter(m => DEL_DUENO(m) || m.tipo === "reembolso");
  // lo que faltaba por recuperar después de cada movimiento (se calcula del más viejo al más nuevo)
  let acum = 0; const quedaba = new Map();
  for (const m of [...items].reverse()) { acum = r2(acum + (m.tipo === "reembolso" ? -m.monto : m.monto)); quedaba.set(m.id, acum); }
  const cont = $("#pgLista"); cont.textContent = "";
  if (!items.length) {
    const p = document.createElement("p"); p.className = "vacio";
    p.textContent = "Aún no hay pagos del dueño. Al registrar un gasto o una reparación, elige «Bolsa del dueño».";
    cont.append(p); return;
  }
  for (const m of items) {
    const rec = m.tipo === "reembolso";
    const row = document.createElement("div"); row.className = "rep";
    const f = document.createElement("div"); f.className = "f";
    const d0 = parseISO(m.fecha);
    const dd = document.createElement("b"); dd.textContent = d0.getDate();
    f.append(dd, document.createTextNode(mesAbrev(d0) + " " + String(d0.getFullYear()).slice(2)));
    const tx = document.createElement("div");
    const nm = document.createElement("div"); nm.className = "nm";
    nm.textContent = rec ? (m.categoria || "Recuperación del dueño") : (m.tipo === "reparacion" ? "Reparación: " : "") + (m.categoria || "Sin concepto");
    const det = document.createElement("div"); det.className = "det";
    det.textContent = [rec ? "Recuperado de la caja" : "Pagado de su bolsa", m.nota,
      "pendiente después: " + fmt.format(Math.max(0, quedaba.get(m.id)))].filter(Boolean).join(" · ");
    tx.append(nm, det);
    const der = document.createElement("div"); der.className = "der";
    const mm = document.createElement("span"); mm.className = "m " + (rec ? "in" : "dueno");
    mm.textContent = (rec ? "−" : "+") + fmt.format(m.monto); der.append(mm);
    const mini = document.createElement("div"); mini.className = "mini";
    const ed = document.createElement("button"); ed.textContent = "Editar"; ed.onclick = () => editar(m);
    mini.append(ed); der.append(mini);
    row.append(f, tx, der); cont.append(row);
  }
}

// Relación de reparaciones: todas, sin importar el periodo elegido
function renderReparaciones() {
  const reps = movs.filter(m => m.tipo === "reparacion");
  const anio = hoyISO().slice(0, 4);
  $("#repAnio").textContent = fmt.format(reps.filter(m => m.fecha.startsWith(anio)).reduce((s, m) => s + m.monto, 0));
  $("#repTotal").textContent = fmt.format(reps.reduce((s, m) => s + m.monto, 0));
  $("#repNum").textContent = reps.length;
  const conKm = reps.find(m => m.km);
  $("#repUltimo").textContent = reps.length
    ? "Última: " + fechaCorta.format(parseISO(reps[0].fecha)) + (conKm ? " · " + kmFmt.format(conKm.km) + " km" : "") : "";
  const cont = $("#reps"); cont.textContent = "";
  if (!reps.length) {
    const p = document.createElement("p"); p.className = "vacio";
    p.textContent = "Aún no hay reparaciones. Regístralas con el botón Registrar reparación.";
    cont.append(p); $("#repMasWrap").hidden = true; return;
  }
  const LIM = 8;
  $("#repMasWrap").hidden = reps.length <= LIM;
  $("#repMas").textContent = repTodas ? "Ver menos" : "Ver todas (" + reps.length + ")";
  for (const m of repTodas ? reps : reps.slice(0, LIM)) {
    const row = document.createElement("div"); row.className = "rep";
    const f = document.createElement("div"); f.className = "f";
    const d = parseISO(m.fecha);
    const dd = document.createElement("b"); dd.textContent = d.getDate();
    f.append(dd, document.createTextNode(fechaCorta.format(d).replace(/^\d+\s*(de\s*)?/, "").replace(".", "") + " " + String(d.getFullYear()).slice(2)));
    const tx = document.createElement("div");
    const nm = document.createElement("div"); nm.className = "nm"; nm.textContent = m.categoria || "Sin descripción";
    tx.append(nm);
    const partes = [m.taller, m.km ? kmFmt.format(m.km) + " km" : "", m.nota].filter(Boolean);
    if (partes.length) { const det = document.createElement("div"); det.className = "det"; det.textContent = partes.join(" · "); tx.append(det); }
    const der = document.createElement("div"); der.className = "der";
    const mm = document.createElement("span"); mm.className = "m"; mm.textContent = fmt.format(m.monto); der.append(mm);
    if (!SALE(m)) { const fu = document.createElement("span"); fu.className = "fuera"; fu.textContent = m.pagoDueno ? "pagó el dueño" : "fuera de caja"; der.append(fu); }
    const mini = document.createElement("div"); mini.className = "mini";
    const ed = document.createElement("button"); ed.textContent = "Editar"; ed.onclick = () => editar(m);
    mini.append(ed); der.append(mini);
    row.append(f, tx, der); cont.append(row);
  }
}

function render() {
  pintarEstado();
  pintarCampana();
  let tIn = 0, tOut = 0;
  for (const m of movs) { if (ENTRA(m.tipo)) tIn += m.monto; else if (SALE(m)) tOut += m.monto; }
  const ini = movs.find(m => m.tipo === "inicial");
  const saldo = (ini ? ini.monto : 0) + tIn - tOut;
  $("#tIniWrap").hidden = !ini;
  if (ini) $("#tIni").textContent = fmt.format(ini.monto);
  $("#iniBtnWrap").hidden = !$("#iniCard").hidden;
  $("#iniBtn").textContent = ini ? "Cambiar saldo inicial" : "Poner saldo inicial";
  $("#saldo").textContent = fmt.format(saldo);
  $("#saldo").classList.toggle("neg", saldo < 0);
  $("#tIn").textContent = fmt.format(tIn);
  $("#tOut").textContent = fmt.format(tOut);

  const deudas = calcularDeudas();
  $("#tDebe").textContent = fmt.format(deudas.reduce((s, c) => s + Math.max(0, c.pendiente), 0));
  renderDeudas(deudas);
  const deben = deudas.filter(c => c.pendiente > 0).length;
  const aviso = $("#tabs [data-v=\"deudas\"] .badge");
  aviso.hidden = !deben; aviso.textContent = deben;
  const dueno = calcularDueno();
  $("#tDuenoWrap").hidden = dueno.pendiente <= 0;
  $("#tDueno").textContent = fmt.format(dueno.pendiente);
  renderPagos(dueno);
  renderBalance();
  renderReparaciones();

  const vis = movs.filter(m => m.tipo !== "inicial" && enPeriodo(m.fecha));
  const lista = $("#lista"); lista.textContent = "";
  if (!vis.length) {
    const p = document.createElement("p"); p.className = "vacio";
    p.textContent = movs.length ? "No hay movimientos en este periodo." : "Todavía no hay registros. Captura la primera cuenta o gasto en el formulario de arriba.";
    lista.append(p); return;
  }
  const grupos = new Map();
  for (const m of vis) { if (!grupos.has(m.fecha)) grupos.set(m.fecha, []); grupos.get(m.fecha).push(m); }
  for (const [f, items] of grupos) {
    const dia = document.createElement("div"); dia.className = "dia";
    const h = document.createElement("h3");
    const neto = items.reduce((s, m) => s + (ENTRA(m.tipo) ? m.monto : SALE(m) ? -m.monto : 0), 0);
    const a = document.createElement("span"); a.textContent = fechaLarga.format(parseISO(f));
    const b = document.createElement("span"); b.className = "num"; b.textContent = (neto >= 0 ? "+" : "") + fmt.format(neto);
    h.append(a, b); dia.append(h);
    for (const m of items) {
      const row = document.createElement("div"); row.className = "mov " + m.tipo + (DEL_DUENO(m) ? " dueno" : m.tipo === "reparacion" && !SALE(m) ? " fuera" : "");
      const st = document.createElement("span"); st.className = "st";
      const tx = document.createElement("div"); tx.className = "tx";
      const cat = document.createElement("div"); cat.className = "cat";
      cat.textContent = m.tipo === "adeudo" ? "Deuda: " + (m.categoria || "Cuenta del día")
        : m.tipo === "abono" ? (m.categoria || "Pago de deuda")
        : m.tipo === "reparacion" ? "Reparación: " + (m.categoria || "Sin descripción")
        : m.tipo === "reembolso" ? (m.categoria || "Recuperación del dueño") : (m.categoria || "Sin concepto");
      const det = document.createElement("div"); det.className = "det";
      const partes = [];
      if (m.chofer) partes.push("Chofer " + m.chofer);
      if (m.taller) partes.push(m.taller);
      if (m.km) partes.push(kmFmt.format(m.km) + " km");
      if (DEL_DUENO(m)) partes.push("lo pagó el dueño, por recuperar");
      else if (m.tipo === "reparacion" && !SALE(m)) partes.push("no salió de la caja");
      if (m.tipo === "adeudo" && m.esperado) partes.push("debía " + fmt.format(m.esperado) + ", entregó " + fmt.format(m.entregado || 0));
      if (m.nota) partes.push(m.nota);
      if (m.autor) partes.push("Registró " + m.autor);
      det.textContent = partes.join(" · ");
      tx.append(cat); if (det.textContent) tx.append(det);
      const der = document.createElement("div"); der.className = "der";
      const mm = document.createElement("span");
      if (m.tipo === "adeudo") { mm.className = "m debe"; mm.textContent = "Debe " + fmt.format(m.monto); }
      else if (ENTRA(m.tipo)) { mm.className = "m in"; mm.textContent = "+" + fmt.format(m.monto); }
      else { mm.className = "m " + (SALE(m) ? "out" : ""); mm.textContent = (SALE(m) ? "−" : "") + fmt.format(m.monto); }
      der.append(mm);
      const mini = document.createElement("div"); mini.className = "mini";
      if (borrando === m.id) {
        const ligado = m.ligado && movs.some(x => x.id === m.ligado);
        const si = document.createElement("button"); si.className = "peligro";
        si.textContent = ligado ? "Sí, borrar deuda y su entrada" : "Sí, borrar";
        si.onclick = () => borrar(m);
        const no = document.createElement("button"); no.textContent = "No";
        no.onclick = () => { borrando = null; render(); };
        mini.append(si, no);
      } else {
        const ed = document.createElement("button"); ed.textContent = "Editar"; ed.onclick = () => editar(m);
        const br = document.createElement("button"); br.textContent = "Borrar"; br.onclick = () => { borrando = m.id; render(); };
        mini.append(ed, br);
      }
      der.append(mini);
      row.append(st, tx, der); dia.append(row);
    }
    lista.append(dia);
  }
}

function msg(t, cls, sel = "#msg") { const e = $(sel); e.textContent = t; e.className = "msg " + (cls || ""); }

function editar(m) {
  editId = m.id; borrando = null;
  pagoCon = DEL_DUENO(m) ? "dueno" : m.tipo === "reparacion" && m.deCaja === false ? "otro" : "caja";
  ponerTipo(m.tipo, m.categoria || "");
  document.querySelectorAll(".tipo button").forEach(b => b.disabled = b.dataset.v !== m.tipo);
  $("#monto").value = m.monto; $("#fecha").value = m.fecha; $("#nota").value = m.nota || ""; $("#chofer").value = m.chofer || "";
  $("#taller").value = m.taller || ""; $("#km").value = m.km || "";
  $("#formTitulo").textContent = "Editar movimiento";
  $("#guardar").textContent = "Guardar cambios";
  $("#cancelar").hidden = false; msg("");
  irA("registros");
  $("#captura").scrollIntoView({ behavior: "smooth", block: "start" });
  render();
}
function limpiar() {
  editId = null;
  for (const id of ["#monto", "#nota", "#categoria", "#chofer", "#esperado", "#entregado", "#taller", "#km"]) $(id).value = "";
  pagoCon = "caja";
  $("#fecha").value = hoyISO();
  document.querySelectorAll(".tipo button").forEach(b => b.disabled = false);
  $("#formTitulo").textContent = "Registrar movimiento";
  $("#guardar").textContent = "Guardar"; $("#cancelar").hidden = true;
}

function borrar(m) {
  const ops = [];
  if (m.ligado && movs.some(x => x.id === m.ligado)) ops.push({ tipo: "mov.borrar", id: m.ligado });
  ops.push({ tipo: "mov.borrar", id: m.id });
  borrando = null; if (editId === m.id) { limpiar(); ponerTipo("ingreso"); }
  cambiar(ops);
}

$("#form").addEventListener("submit", ev => {
  ev.preventDefault();
  const fecha = $("#fecha").value;
  const nota = limpio($("#nota").value);
  const chofer = limpio($("#chofer").value);
  const concepto = limpio($("#categoria").value);
  const conChofer = tipo === "adeudo" || tipo === "abono";
  if (conChofer && !chofer) { msg("Escribe el nombre del chofer.", "err"); $("#chofer").focus(); return; }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha)) { msg("Elige la fecha del movimiento.", "err"); $("#fecha").focus(); return; }
  if (!conChofer && tipo !== "reembolso" && !concepto) { msg("Escribe el concepto del movimiento.", "err"); $("#categoria").focus(); return; }

  const previo = editId ? movs.find(m => m.id === editId) : null;
  const base = { fecha, nota, creado: previo ? previo.creado : new Date().toISOString() };
  if (previo) base.editado = new Date().toISOString();

  if (tipo === "adeudo" && !editId) {
    // Cuenta no entregada o incompleta: lo entregado entra a caja y la diferencia queda como deuda
    const esperado = num("#esperado");
    const entregado = isNaN(num("#entregado")) ? 0 : num("#entregado");
    if (!(esperado > 0)) { msg("Escribe cuánto debía entregar el chofer.", "err"); $("#esperado").focus(); return; }
    if (entregado < 0) { msg("Lo entregado no puede ser negativo.", "err"); $("#entregado").focus(); return; }
    if (entregado >= esperado) { msg("Entregó la cuenta completa, así que no hay deuda. Regístrala como Entrada.", "err"); return; }
    const deuda = r2(esperado - entregado);
    const cat = concepto || "Cuenta del día";
    const ops = [];
    let ligado = "";
    if (entregado > 0) {
      ligado = nuevoId();
      ops.push({ tipo: "mov.guardar", mov: { ...base, id: ligado, tipo: "ingreso", monto: entregado, categoria: cat + " (incompleta)", chofer } });
    }
    ops.push({ tipo: "mov.guardar", mov: { ...base, id: nuevoId(), tipo: "adeudo", monto: deuda, esperado, entregado, categoria: cat, chofer, ligado } });
    cambiar(ops);
    msg("Guardado: " + chofer + " queda a deber " + fmt.format(deuda) + (entregado > 0 ? " y entraron " + fmt.format(entregado) + " a caja." : "."), "ok");
  } else {
    const monto = num("#monto");
    if (!(monto > 0)) { msg("Escribe un monto mayor a cero.", "err"); $("#monto").focus(); return; }
    const doc = { ...base, id: editId || nuevoId(), tipo, monto, categoria: concepto || (tipo === "abono" ? "Pago de deuda" : tipo === "adeudo" ? "Cuenta del día" : tipo === "reembolso" ? "Recuperación del dueño" : "") };
    if (conChofer) doc.chofer = chofer;
    else if (previo && previo.chofer) doc.chofer = previo.chofer;
    if (tipo === "reparacion") {
      doc.taller = limpio($("#taller").value);
      const km = parseInt($("#km").value, 10);
      if (km > 0) doc.km = km;
      doc.deCaja = pagoCon === "caja";
    }
    if ((tipo === "gasto" || tipo === "reparacion") && pagoCon === "dueno") doc.pagoDueno = true;
    if (previo && previo.tipo === "adeudo") {
      if (previo.ligado) doc.ligado = previo.ligado;
      if (previo.esperado) { doc.esperado = previo.esperado; doc.entregado = previo.entregado || 0; }
    }
    cambiar([{ tipo: "mov.guardar", mov: doc }]);
    const que = { ingreso: "entrada de ", gasto: "gasto de ", adeudo: "deuda de ", abono: "pago de ", reparacion: "reparación de ", reembolso: "recuperación de " }[tipo];
    msg((editId ? "Cambios guardados: " : "Guardado: ") + que + fmt.format(monto) + (conChofer ? " (" + doc.chofer + ")." : doc.pagoDueno ? ", pagado por el dueño." : "."), "ok");
  }
  const t = tipo; limpiar(); ponerTipo(t, "");
});
document.querySelectorAll("#pago button").forEach(b => b.onclick = () => ponerPago(b.dataset.v));
$("#cancelar").onclick = () => { limpiar(); ponerTipo("ingreso", ""); msg(""); render(); };
document.querySelectorAll(".tipo button").forEach(b => b.onclick = () => { if (!editId) { ponerTipo(b.dataset.v, ""); msg(""); } });
$("#repMas").onclick = () => { repTodas = !repTodas; renderReparaciones(); };
$("#semAnt").onclick = () => { paso--; renderBalance(); };
$("#semSig").onclick = () => { if (paso < 0) { paso++; renderBalance(); } };
document.querySelectorAll("#balModo button").forEach(b => b.onclick = () => { modoBal = b.dataset.v; paso = 0; renderBalance(); });
for (const id of ["#balDesde", "#balHasta"]) $(id).addEventListener("change", () => {
  const a = $("#balDesde").value, z = $("#balHasta").value;
  if (!a || !z) return;
  [rangoDesde, rangoHasta] = a <= z ? [a, z] : [z, a];
  renderBalance();
});
$("#esperado").addEventListener("input", actualizarCalc);
$("#entregado").addEventListener("input", actualizarCalc);
document.querySelectorAll("#periodo button").forEach(b => b.onclick = () => {
  periodo = b.dataset.v;
  document.querySelectorAll("#periodo button").forEach(x => x.setAttribute("aria-pressed", String(x === b)));
  render();
});

/* ---------- secciones (menú inferior y ajustes) ---------- */
const VISTAS = ["registros", "balances", "deudas", "pagos", "reparaciones", "ajustes", "avisos"];
function irA(v) {
  if (!VISTAS.includes(v)) v = "registros";
  document.querySelectorAll(".vista").forEach(s => s.hidden = s.dataset.vista !== v);
  document.querySelectorAll("#tabs button").forEach(b => b.toggleAttribute("aria-current", b.dataset.v === v));
  $("#btnAjustes").setAttribute("aria-pressed", String(v === "ajustes"));
  $("#btnAvisos").setAttribute("aria-pressed", String(v === "avisos"));
  if (v === "avisos") { const antes = LS.get("cam-avisos-visto", ""); marcarVistos(); renderAvisos(antes); estadoPush(); }
  else if (v !== "ajustes") LS.set("cam-vista", v);
  window.scrollTo(0, 0);
}
document.querySelectorAll("#tabs button").forEach(b => b.onclick = () => irA(b.dataset.v));
$("#btnAjustes").onclick = () => irA("ajustes");
$("#btnAvisos").onclick = () => irA("avisos");
$("#pgRecuperar").onclick = () => {
  limpiar(); ponerTipo("reembolso", ""); msg("");
  $("#monto").value = Math.max(0, calcularDueno().pendiente);
  irA("registros"); $("#monto").focus({ preventScroll: true });
};
$("#pgNuevo").onclick = () => {
  limpiar(); pagoCon = "dueno"; ponerTipo("gasto", ""); msg(""); irA("registros");
  $("#categoria").focus({ preventScroll: true });
};
$("#repNueva").onclick = () => {
  limpiar(); ponerTipo("reparacion", ""); msg(""); irA("registros");
  $("#categoria").focus({ preventScroll: true });
};

/* ---------- avisos y notificaciones (solo para el dueño) ---------- */
function recibirAvisos(lista) {
  avisos = lista; LS.set("cam-avisos", avisos);
  const nuevo = avisos[0] ? avisos[0].t : "";
  const ultimo = LS.get("cam-avisos-ultimo", null);
  // la primera vez no se avisa de lo que ya había
  if (ultimo === null) { LS.set("cam-avisos-ultimo", nuevo); if (LS.get("cam-avisos-visto", null) === null) LS.set("cam-avisos-visto", nuevo); return; }
  if (nuevo && nuevo > ultimo) {
    LS.set("cam-avisos-ultimo", nuevo);
    const vistaAvisos = !$('[data-vista="avisos"]').hidden;
    if (vistaAvisos) marcarVistos(); else mostrarToast(avisos[0]);
  }
}
function marcarVistos() { if (avisos[0]) LS.set("cam-avisos-visto", avisos[0].t); pintarCampana(); }
function pintarCampana() {
  const visto = LS.get("cam-avisos-visto", "");
  const n = avisos.filter(a => a.t > visto).length;
  const b = $("#btnAvisos .badge"); b.hidden = !n; b.textContent = n > 9 ? "9+" : n;
}
let toastTimer = null;
function mostrarToast(a) {
  const t = $("#toast");
  t.textContent = "🔔 " + (a.usuario ? a.usuario + ": " : "") + a.texto.split("\n")[0];
  t.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, 8000);
}
$("#toast").onclick = () => { $("#toast").hidden = true; irA("avisos"); };

// visto: hasta dónde ya se habían leído, para resaltar los nuevos
function renderAvisos(visto = "") {
  const cont = $("#avLista"); cont.textContent = "";
  if (!avisos.length) {
    const p = document.createElement("p"); p.className = "vacio";
    p.textContent = "Aún no hay avisos. Aquí vas a ver cada movimiento que registre, cambie o borre tu administrador.";
    cont.append(p); return;
  }
  for (const a of avisos) {
    const row = document.createElement("div"); row.className = "avi" + (a.t > visto ? " nuevo" : "");
    const h = document.createElement("div"); h.className = "det";
    const fecha = new Date(a.t);
    h.textContent = (isNaN(fecha) ? "" : horaCorta.format(fecha)) + (a.usuario ? " · " + a.usuario : "");
    const tx = document.createElement("div"); tx.className = "tx";
    tx.textContent = a.texto;
    row.append(h, tx); cont.append(row);
  }
}

// El service worker necesita la dirección de la hoja y la sesión para pedir el aviso cuando llega una notificación
function configurarSW() {
  if (!("serviceWorker" in navigator) || location.protocol === "file:") return;
  navigator.serviceWorker.ready.then(r => r.active && r.active.postMessage({ tipo: "sesion", api: new URL(API, location.href).href, token: sesion ? sesion.token : null })).catch(() => {});
}
const b64aBytes = t => Uint8Array.from(atob(t.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((t.length + 3) % 4)), c => c.charCodeAt(0));
const soportaPush = () => "serviceWorker" in navigator && "PushManager" in window && "Notification" in window && location.protocol !== "file:";
async function suscripcion() { try { return await (await navigator.serviceWorker.ready).pushManager.getSubscription(); } catch { return null; } }

async function estadoPush() {
  const e = $("#pushEstado"), act = $("#pushActivar"), pr = $("#pushProbar"), qu = $("#pushQuitar");
  act.hidden = pr.hidden = qu.hidden = true;
  if (!soportaPush()) { e.textContent = "Este navegador no permite notificaciones. En iPhone primero instala la app en la pantalla de inicio. Los avisos siguen apareciendo aquí."; return; }
  if (Notification.permission === "denied") { e.textContent = "Las notificaciones están bloqueadas para esta app. Actívalas en los ajustes del teléfono (Notificaciones de Chrome o de la app) y vuelve a entrar aquí."; return; }
  const sub = Notification.permission === "granted" ? await suscripcion() : null;
  if (sub) { e.textContent = "Las notificaciones están activas en este teléfono: te llega una cada vez que tu administrador registra, cambia o borra algo, aunque la app esté cerrada."; pr.hidden = qu.hidden = false; }
  else { e.textContent = "Activa las notificaciones para enterarte al momento de lo que registra tu administrador, aunque la app esté cerrada."; act.hidden = false; }
}
$("#pushActivar").onclick = async () => {
  msg("Activando…", "", "#pushMsg");
  try {
    if (await Notification.requestPermission() !== "granted") { msg("No se dio permiso para las notificaciones.", "err", "#pushMsg"); return estadoPush(); }
    const { clave } = await api({ accion: "push.clave", token: sesion.token });
    const reg = await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();
    // si la llave del servidor cambió hay que volver a suscribirse
    if (sub && sub.options.applicationServerKey && btoa(String.fromCharCode(...new Uint8Array(sub.options.applicationServerKey))) !== btoa(String.fromCharCode(...b64aBytes(clave)))) { await sub.unsubscribe(); sub = null; }
    if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64aBytes(clave) });
    await api({ accion: "push.suscribir", token: sesion.token, sub: sub.toJSON() });
    configurarSW();
    msg("Listo. Toca «Mandar una prueba» para comprobarlo.", "ok", "#pushMsg");
  } catch (e) {
    if (e.auth) return salir("Tu sesión expiró. Vuelve a iniciar sesión.", true);
    msg("No se pudieron activar: " + e.message, "err", "#pushMsg");
  }
  estadoPush();
};
$("#pushProbar").onclick = async () => {
  msg("Mandando…", "", "#pushMsg");
  try {
    const j = await api({ accion: "push.probar", token: sesion.token });
    if (j.avisos) { const antes = LS.get("cam-avisos-visto", ""); recibirAvisos(j.avisos); marcarVistos(); renderAvisos(antes); }
    const r = j.resultados || [];
    const bien = r.filter(c => c >= 200 && c < 300).length;
    msg(bien ? "Enviada. Debe llegarte en unos segundos." : "No se pudo enviar (" + (r.join(", ") || "sin teléfonos registrados") + "). Desactiva y vuelve a activar.", bien ? "ok" : "err", "#pushMsg");
  } catch (e) { msg(e.message, "err", "#pushMsg"); }
};
$("#pushQuitar").onclick = async () => {
  const sub = await suscripcion();
  if (sub) { api({ accion: "push.quitar", token: sesion.token, endpoint: sub.endpoint }).catch(() => {}); await sub.unsubscribe().catch(() => {}); }
  msg("Desactivadas en este teléfono.", "", "#pushMsg");
  estadoPush();
};
// al tocar una notificación con la app abierta
if ("serviceWorker" in navigator) navigator.serviceWorker.addEventListener("message", e => {
  if (e.data && e.data.tipo === "abrir-avisos" && sesion) { irA("avisos"); enviar(); }
});

/* ---------- saldo inicial (un solo registro fijo) ---------- */
function cerrarIni() { $("#iniCard").hidden = true; msg("", "", "#iniMsg"); render(); }
$("#iniBtn").onclick = () => {
  const ini = movs.find(m => m.tipo === "inicial");
  $("#iniMonto").value = ini ? ini.monto : "";
  $("#iniFecha").value = ini ? ini.fecha : hoyISO();
  $("#iniQuitar").hidden = !ini;
  $("#iniCard").hidden = false; $("#iniBtnWrap").hidden = true; msg("", "", "#iniMsg");
  $("#iniMonto").focus();
};
$("#iniCancelar").onclick = cerrarIni;
$("#iniForm").addEventListener("submit", ev => {
  ev.preventDefault();
  const monto = num("#iniMonto"), fecha = $("#iniFecha").value;
  if (isNaN(monto)) { msg("Escribe el monto del saldo inicial.", "err", "#iniMsg"); $("#iniMonto").focus(); return; }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha)) { msg("Elige la fecha.", "err", "#iniMsg"); $("#iniFecha").focus(); return; }
  const previo = movs.find(m => m.tipo === "inicial");
  $("#iniCard").hidden = true;
  cambiar([{ tipo: "mov.guardar", mov: { id: "saldo-inicial", tipo: "inicial", monto, fecha, categoria: "Saldo inicial",
    creado: previo ? previo.creado : new Date().toISOString(), ...(previo ? { editado: new Date().toISOString() } : {}) } }]);
});
$("#iniQuitar").onclick = () => { $("#iniCard").hidden = true; cambiar([{ tipo: "mov.borrar", id: "saldo-inicial" }]); };

/* ---------- sesión ---------- */
const ROLES = { dueno: "Dueño", admin: "Administrador" };
function mostrarApp() {
  $("#pantallaLogin").hidden = true; $("#pantallaApp").hidden = false;
  $("#rol").textContent = ROLES[sesion.rol] || sesion.rol;
  $("#ajSesion").textContent = "Entraste como " + sesion.usuario + " (" + (ROLES[sesion.rol] || sesion.rol) + ").";
  $("#adminForm").hidden = sesion.rol !== "dueno";
  const soyDueno = sesion.rol === "dueno";
  $("#tabPagos").textContent = soyDueno ? "Mis pagos" : "Pagos dueño";
  $("#pgTit").textContent = soyDueno ? "Lo que pagué de mi bolsa" : "Lo que pagó el dueño";
  $("#tDuenoLbl").textContent = soyDueno ? "Te falta recuperar" : "Por devolver al dueño";
  $("#btnAvisos").hidden = !soyDueno;
  const pedida = new URLSearchParams(location.search).get("vista");
  irA(pedida === "avisos" && soyDueno ? "avisos" : LS.get("cam-vista", soyDueno ? "balances" : "registros"));
  if (pedida) history.replaceState(null, "", location.pathname);
  configurarSW();
  recalcular(); llenarSugerencias(); render();
  enviar();
}
function mostrarLogin(texto, error) {
  $("#pantallaApp").hidden = true; $("#pantallaLogin").hidden = false;
  msg(texto || "", error ? "err" : "", "#lMsg");
  $("#lUsuario").focus();
}
function salir(texto, error) {
  const token = sesion && sesion.token;
  sesion = null; LS.del("cam-sesion");
  if (!error && token) api({ accion: "logout", token }).catch(() => {});
  // al cerrar sesión a propósito se borra la copia local (los datos siguen en la hoja de Google)
  if (!error) { servidor = []; cola = []; LS.del("cam-datos"); LS.del("cam-cola"); LS.del("cam-actualizado"); LS.del("cam-vista");
    avisos = []; for (const k of ["cam-avisos", "cam-avisos-visto", "cam-avisos-ultimo"]) LS.del(k); }
  configurarSW();
  mostrarLogin(texto, error);
}
$("#btnSalir").onclick = () => salir("Cerraste sesión.");

$("#loginForm").addEventListener("submit", async ev => {
  ev.preventDefault();
  const usuario = $("#lUsuario").value.trim().toLowerCase(), claveTxt = $("#lClave").value, codigo = $("#lCodigo").value.trim();
  if (!usuario || !claveTxt) { msg("Escribe tu usuario y contraseña.", "err", "#lMsg"); return; }
  $("#lEntrar").disabled = true; msg("Entrando…", "", "#lMsg");
  try {
    const j = await api({ accion: "login", usuario, clave: claveTxt, codigo });
    sesion = { token: j.token, usuario: j.usuario, rol: j.rol };
    LS.set("cam-sesion", sesion);
    recibir(j);
    $("#lClave").value = ""; $("#lCodigo").value = "";
    mostrarApp();
  } catch (e) {
    if (e.necesitaCodigo) { $("#lCodigoWrap").hidden = false; $("#lAyudaCodigo").hidden = false; }
    msg(e.message, "err", "#lMsg");
  } finally { $("#lEntrar").disabled = false; }
});

$("#claveForm").addEventListener("submit", async ev => {
  ev.preventDefault();
  const actual = $("#cActual").value, nueva = $("#cNueva").value;
  if (nueva.length < 8) { msg("La contraseña nueva debe tener al menos 8 caracteres.", "err", "#cMsg"); return; }
  try {
    await api({ accion: "clave.cambiar", token: sesion.token, actual, nueva });
    $("#cActual").value = ""; $("#cNueva").value = "";
    msg("Contraseña cambiada.", "ok", "#cMsg");
  } catch (e) { if (e.auth) return salir("Tu sesión expiró. Vuelve a iniciar sesión.", true); msg(e.message, "err", "#cMsg"); }
});
$("#adminForm").addEventListener("submit", async ev => {
  ev.preventDefault();
  const usuario = $("#aUsuario").value.trim().toLowerCase(), claveTxt = $("#aClave").value;
  if (usuario.length < 3) { msg("El usuario debe tener al menos 3 caracteres.", "err", "#aMsg"); return; }
  if (claveTxt.length < 8) { msg("La contraseña debe tener al menos 8 caracteres.", "err", "#aMsg"); return; }
  try {
    await api({ accion: "admin.guardar", token: sesion.token, usuario, clave: claveTxt });
    $("#aUsuario").value = ""; $("#aClave").value = "";
    msg("Listo. Tu administrador ya puede entrar como " + usuario + ".", "ok", "#aMsg");
  } catch (e) { if (e.auth) return salir("Tu sesión expiró. Vuelve a iniciar sesión.", true); msg(e.message, "err", "#aMsg"); }
});

/* ---------- instalación ---------- */
let promptInstalar = null;
window.addEventListener("beforeinstallprompt", e => { e.preventDefault(); promptInstalar = e; $("#btnInstalar").hidden = false; });
$("#btnInstalar").onclick = async () => { if (!promptInstalar) return; promptInstalar.prompt(); await promptInstalar.userChoice; promptInstalar = null; $("#btnInstalar").hidden = true; };
window.addEventListener("appinstalled", () => { $("#btnInstalar").hidden = true; });
const enApp = matchMedia("(display-mode: standalone)").matches || navigator.standalone;
$("#ayudaIos").hidden = enApp || !/iphone|ipad|ipod/i.test(navigator.userAgent);
if ("serviceWorker" in navigator && location.protocol !== "file:") navigator.serviceWorker.register("sw.js").catch(() => {});

/* ---------- arranque ---------- */
$("#fecha").value = hoyISO();
ponerTipo("ingreso");
if (sesion && sesion.token) mostrarApp(); else mostrarLogin();
