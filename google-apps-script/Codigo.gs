/**
 * Servidor de "Cuentas de la Camioneta" sobre Google Sheets.
 *
 * Instalación (una sola vez):
 *  1. Crea una hoja de cálculo nueva en Google Drive (ej. "Cuentas Camioneta").
 *  2. Menú Extensiones → Apps Script. Borra lo que haya y pega TODO este archivo. Guarda.
 *  3. Implementar → Nueva implementación → tipo "Aplicación web".
 *       Ejecutar como: Yo    ·    Quién tiene acceso: Cualquier persona
 *     Copia la URL que termina en /exec y ponla en config.js de la app.
 *  4. Abre la app: la primera vez pide un código de instalación, que aparece en la pestaña
 *     "Instalación" de la hoja. Ese primer usuario queda como Dueño; desde Ajustes crea al administrador.
 *
 * Nadie ve los datos sin iniciar sesión. Las contraseñas se guardan cifradas (SHA-256 con sal)
 * en las propiedades del script, nunca en el código ni en la hoja.
 */

const COLUMNAS = ['id', 'tipo', 'fecha', 'monto', 'categoria', 'chofer', 'nota', 'taller', 'km', 'deCaja',
  'esperado', 'entregado', 'ligado', 'autor', 'creado', 'editado', 'pagoDueno'];
const NUMERICOS = ['monto', 'km', 'esperado', 'entregado'];
// reembolso: dinero que sale de la caja para devolverle al dueño lo que pagó de su bolsa
const TIPOS = ['ingreso', 'gasto', 'adeudo', 'abono', 'reparacion', 'inicial', 'reembolso'];
const HOJA = 'Movimientos';
const DIAS_SESION = 180;
const props = () => PropertiesService.getScriptProperties();

/* ---------- web app ---------- */
function doGet() {
  return responder(() => ({ ok: true, app: 'Cuentas de la Camioneta', instalado: !!props().getProperty('USUARIOS') }));
}

function doPost(e) {
  return responder(() => {
    const b = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    if (b.accion === 'login') return iniciarSesion(b.usuario, b.clave, b.codigo);
    if (b.accion === 'logout') { cerrarSesion(b.token); return { ok: true }; }
    const s = sesion(b.token);
    if (!s) return { ok: false, auth: true, error: 'Tu sesión expiró. Vuelve a iniciar sesión.' };
    switch (b.accion) {
      case 'datos': return datos();
      case 'ops': {
        const lock = LockService.getScriptLock();
        lock.waitLock(25000);
        try { (b.ops || []).forEach(op => aplicar(op, s)); } finally { lock.releaseLock(); }
        return datos();
      }
      case 'clave.cambiar': return cambiarClave(s, b.actual, b.nueva);
      case 'admin.guardar': return guardarAdmin(s, b.usuario, b.clave);
      default: return { ok: false, error: 'Acción desconocida' };
    }
  });
}

function responder(fn) {
  let out;
  try { out = fn(); } catch (err) { out = { ok: false, error: String(err && err.message || err) }; }
  return ContentService.createTextOutput(JSON.stringify(out)).setMimeType(ContentService.MimeType.JSON);
}

/* ---------- usuarios y sesiones ---------- */
function hashClave(clave, sal) {
  let h = sal + '|' + clave;
  for (let i = 0; i < 200; i++) {
    h = Utilities.base64Encode(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, h + '|' + sal, Utilities.Charset.UTF_8));
  }
  return h;
}
function leerJSON(k) { try { return JSON.parse(props().getProperty(k) || '{}'); } catch (err) { return {}; } }
const usuarios = () => leerJSON('USUARIOS');
function guardarUsuarios(u) { props().setProperty('USUARIOS', JSON.stringify(u)); }
function nuevoUsuario(rol, clave) { const sal = Utilities.getUuid(); return { rol: rol, sal: sal, hash: hashClave(clave, sal) }; }

/* Primera vez: aún no hay usuarios. El script genera un código de 6 dígitos que solo se ve en la hoja
   (pestaña "Instalación"); quien lo escriba en la app con su usuario y contraseña queda como Dueño. */
function codigoInstalacion() {
  let c = props().getProperty('CODIGO_INSTALACION');
  if (!c) { c = String(100000 + Math.floor(Math.random() * 900000)); props().setProperty('CODIGO_INSTALACION', c); }
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const h = ss.getSheetByName('Instalación') || ss.insertSheet('Instalación', 0);
  h.getRange(1, 1, 3, 1).setValues([
    ['Código de instalación del dueño:'],
    ["'" + c],
    ['Escríbelo en la app la primera vez que inicies sesión. Después esta pestaña se borra sola.'],
  ]);
  h.getRange(2, 1).setFontSize(28).setFontWeight('bold');
  return c;
}

function iniciarSesion(usuario, clave, codigo) {
  usuario = String(usuario || '').trim().toLowerCase();
  clave = String(clave || '');
  const cache = CacheService.getScriptCache();
  const fallos = Number(cache.get('fallos') || 0);
  if (fallos >= 5) return { ok: false, error: 'Demasiados intentos fallidos. Espera 15 minutos.' };
  let us = usuarios();
  if (!Object.keys(us).length) {
    const real = codigoInstalacion();
    if (!codigo) return { ok: false, necesitaCodigo: true, error: 'Primera vez: escribe el código de instalación que aparece en tu hoja de Google.' };
    if (String(codigo).trim() !== real) {
      cache.put('fallos', String(fallos + 1), 900); Utilities.sleep(1200);
      return { ok: false, necesitaCodigo: true, error: 'Código de instalación incorrecto.' };
    }
    if (usuario.length < 3 || clave.length < 8) return { ok: false, necesitaCodigo: true, error: 'El usuario debe tener al menos 3 caracteres y la contraseña al menos 8.' };
    us = {}; us[usuario] = nuevoUsuario('dueno', clave);
    guardarUsuarios(us);
    props().deleteProperty('CODIGO_INSTALACION');
    const ss = SpreadsheetApp.getActiveSpreadsheet(), hi = ss.getSheetByName('Instalación');
    if (hi) ss.deleteSheet(hi);
  }
  const u = us[usuario];
  if (!u || hashClave(clave, u.sal) !== u.hash) {
    cache.put('fallos', String(fallos + 1), 900); Utilities.sleep(1200);
    return { ok: false, error: 'Usuario o contraseña incorrectos.' };
  }
  cache.remove('fallos');
  const token = Utilities.getUuid() + Utilities.getUuid();
  const ses = leerSesiones();
  ses[token] = { u: usuario, exp: Date.now() + DIAS_SESION * 86400000 };
  props().setProperty('SESIONES', JSON.stringify(ses));
  const out = datos();
  out.token = token; out.usuario = usuario; out.rol = u.rol;
  return out;
}

function leerSesiones() {
  const ses = leerJSON('SESIONES'), ahora = Date.now();
  Object.keys(ses).forEach(t => { if (!ses[t] || ses[t].exp < ahora) delete ses[t]; });
  return ses;
}
function sesion(token) {
  if (typeof token !== 'string' || token.length < 30) return null;
  const s = leerSesiones()[token];
  if (!s) return null;
  const u = usuarios()[s.u];
  return u ? { usuario: s.u, rol: u.rol, token: token } : null;
}
function cerrarSesion(token) { const ses = leerSesiones(); delete ses[token]; props().setProperty('SESIONES', JSON.stringify(ses)); }
function cerrarSesionesDe(usuario, excepto) {
  const ses = leerSesiones();
  Object.keys(ses).forEach(t => { if (ses[t].u === usuario && t !== excepto) delete ses[t]; });
  props().setProperty('SESIONES', JSON.stringify(ses));
}

function cambiarClave(s, actual, nueva) {
  const us = usuarios(), u = us[s.usuario];
  if (hashClave(String(actual || ''), u.sal) !== u.hash) return { ok: false, error: 'La contraseña actual no es correcta.' };
  if (String(nueva || '').length < 8) return { ok: false, error: 'La contraseña nueva debe tener al menos 8 caracteres.' };
  us[s.usuario] = nuevoUsuario(u.rol, String(nueva));
  guardarUsuarios(us);
  cerrarSesionesDe(s.usuario, s.token);
  return { ok: true };
}

// Solo el dueño crea o cambia al administrador (uno solo); las sesiones del administrador anterior se cierran.
function guardarAdmin(s, usuario, clave) {
  if (s.rol !== 'dueno') return { ok: false, error: 'Solo el dueño puede cambiar al administrador.' };
  usuario = String(usuario || '').trim().toLowerCase(); clave = String(clave || '');
  if (!/^[a-z0-9._-]{3,30}$/.test(usuario)) return { ok: false, error: 'El usuario debe tener de 3 a 30 letras o números, sin espacios.' };
  if (clave.length < 8) return { ok: false, error: 'La contraseña debe tener al menos 8 caracteres.' };
  const us = usuarios();
  if (us[usuario] && us[usuario].rol === 'dueno') return { ok: false, error: 'Ese usuario ya es el del dueño. Elige otro.' };
  Object.keys(us).forEach(k => { if (us[k].rol === 'admin') { delete us[k]; cerrarSesionesDe(k); } });
  us[usuario] = nuevoUsuario('admin', clave);
  guardarUsuarios(us);
  return { ok: true };
}

/* ---------- hoja ---------- */
function hoja() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let h = ss.getSheetByName(HOJA);
  if (!h) {
    h = ss.insertSheet(HOJA);
    h.getRange(1, 1, 1, COLUMNAS.length).setValues([COLUMNAS]).setFontWeight('bold');
    h.setFrozenRows(1);
    h.getRange(2, COLUMNAS.indexOf('monto') + 1, Math.max(h.getMaxRows() - 1, 1), 1).setNumberFormat('$#,##0.00');
    const def = ss.getSheetByName('Hoja 1') || ss.getSheetByName('Sheet1') || ss.getSheetByName('Hoja1');
    if (def && def.getLastRow() === 0) ss.deleteSheet(def);
  }
  // Las columnas nuevas siempre se agregan al final; si la hoja es de una versión anterior se completan los encabezados
  const enc = h.getRange(1, 1, 1, COLUMNAS.length);
  if (enc.getValues()[0].join('|') !== COLUMNAS.join('|')) enc.setValues([COLUMNAS]).setFontWeight('bold');
  return h;
}

function leer() {
  const h = hoja(), n = h.getLastRow();
  if (n < 2) return [];
  const tz = Session.getScriptTimeZone();
  return h.getRange(2, 1, n - 1, COLUMNAS.length).getValues()
    .filter(r => r[0] !== '' && r[0] !== null)
    .map(r => {
      const o = {};
      COLUMNAS.forEach((c, i) => {
        let v = r[i];
        if (v === '' || v === null) return;
        if (v instanceof Date) v = Utilities.formatDate(v, tz, 'yyyy-MM-dd');
        if (c === 'deCaja') o[c] = !(v === false || String(v).toLowerCase() === 'false' || String(v).toLowerCase() === 'no');
        else if (c === 'pagoDueno') { if (v === true || String(v).toLowerCase() === 'true') o[c] = true; }
        else o[c] = NUMERICOS.indexOf(c) >= 0 ? Number(v) || 0 : String(v);
      });
      return o;
    });
}
function datos() { return { ok: true, movimientos: leer() }; }

// El apóstrofo obliga a Sheets a guardar texto tal cual (evita que "2026-10-15" cambie o que "=..." sea fórmula).
function celda(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'number' || typeof v === 'boolean') return v;
  const s = String(v);
  return s === '' ? '' : "'" + s;
}
function buscarFila(h, id) {
  const n = h.getLastRow();
  if (n < 2) return 0;
  const ids = h.getRange(2, 1, n - 1, 1).getValues();
  for (let i = 0; i < ids.length; i++) if (String(ids[i][0]) === String(id)) return i + 2;
  return 0;
}

function aplicar(op, s) {
  const h = hoja();
  if (op.tipo === 'mov.borrar') {
    const r = buscarFila(h, op.id);
    if (r) h.deleteRow(r);
    return;
  }
  if (op.tipo !== 'mov.guardar') throw new Error('Operación desconocida: ' + op.tipo);
  const m = op.mov || {};
  if (!/^[A-Za-z0-9_-]{1,40}$/.test(String(m.id || ''))) throw new Error('Movimiento sin id válido');
  if (TIPOS.indexOf(m.tipo) < 0) throw new Error('Tipo de movimiento desconocido');
  if (typeof m.monto !== 'number' || !isFinite(m.monto)) throw new Error('Monto no válido');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(m.fecha || ''))) throw new Error('Fecha no válida');
  const r = buscarFila(h, m.id);
  let previo = null;
  if (r) {
    const vals = h.getRange(r, 1, 1, COLUMNAS.length).getValues()[0];
    previo = {}; COLUMNAS.forEach((c, i) => { previo[c] = vals[i]; });
  }
  const o = {};
  COLUMNAS.forEach(c => { o[c] = m[c]; });
  // quién registró y cuándo los decide el servidor
  o.autor = previo && previo.autor ? previo.autor : s.usuario;
  o.creado = previo && previo.creado ? previo.creado : (m.creado || new Date().toISOString());
  if (previo) o.editado = new Date().toISOString();
  // Lo que el dueño pagó de su bolsa no sale de la caja (en reparaciones también se marca deCaja = false)
  o.pagoDueno = (m.tipo === 'gasto' || m.tipo === 'reparacion') && m.pagoDueno === true ? true : '';
  if (m.tipo === 'reparacion') o.deCaja = m.deCaja !== false && !o.pagoDueno; else o.deCaja = '';
  const fila = COLUMNAS.map(c => celda(o[c]));
  if (r) h.getRange(r, 1, 1, COLUMNAS.length).setValues([fila]);
  else h.appendRow(fila);
}

/* ---------- menú en la hoja ---------- */
function onOpen() {
  SpreadsheetApp.getUi().createMenu('Camioneta')
    .addItem('Cerrar todas las sesiones', 'cerrarTodasLasSesiones')
    .addItem('Olvidé la contraseña del dueño (reiniciar usuarios)', 'reiniciarUsuarios')
    .addToUi();
}
function cerrarTodasLasSesiones() {
  props().setProperty('SESIONES', '{}');
  SpreadsheetApp.getUi().alert('Se cerraron todas las sesiones. Todos deberán volver a iniciar sesión en la app.');
}
function reiniciarUsuarios() {
  const ui = SpreadsheetApp.getUi();
  const r = ui.alert('Reiniciar usuarios', 'Se borran el dueño y el administrador (los movimientos NO se borran). ' +
    'Al abrir la app pedirá un código de instalación nuevo, que aparecerá en la pestaña "Instalación". ¿Continuar?', ui.ButtonSet.YES_NO);
  if (r !== ui.Button.YES) return;
  props().deleteProperty('USUARIOS');
  props().setProperty('SESIONES', '{}');
  props().deleteProperty('CODIGO_INSTALACION');
  codigoInstalacion();
  ui.alert('Listo. El código nuevo está en la pestaña "Instalación".');
}
