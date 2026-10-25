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
 * Avisos: cuando el administrador registra, cambia o borra algo, queda un aviso en la pestaña "Avisos"
 * y se manda una notificación (Web Push) a los teléfonos donde el dueño la activó.
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
      case 'datos': return conAvisos(datos(), s);
      case 'ops': {
        const lock = LockService.getScriptLock();
        lock.waitLock(25000);
        const hechos = [];
        try { (b.ops || []).forEach(op => { const h = aplicar(op, s); if (h) hechos.push(h); }); } finally { lock.releaseLock(); }
        // un aviso que falla nunca debe impedir que se guarden los movimientos
        if (s.rol !== 'dueno' && hechos.length) { try { avisar(s, hechos); } catch (err) { console.error(err); } }
        return conAvisos(datos(), s);
      }
      case 'avisos': return { ok: true, avisos: s.rol === 'dueno' ? leerAvisos() : [] };
      case 'push.clave': return { ok: true, clave: llavesVapid().pub };
      case 'push.suscribir': return suscribirPush(s, b.sub);
      case 'push.quitar': return quitarPush(b.endpoint);
      case 'push.probar': return probarPush(s);
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
  const out = conAvisos(datos(), { rol: u.rol });
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
  return h.getRange(2, 1, n - 1, COLUMNAS.length).getValues()
    .filter(r => r[0] !== '' && r[0] !== null)
    .map(filaAObjeto);
}
function filaAObjeto(r) {
  const tz = Session.getScriptTimeZone(), o = {};
  COLUMNAS.forEach((c, i) => {
    let v = r[i];
    if (v === '' || v === null) return;
    if (v instanceof Date) v = Utilities.formatDate(v, tz, 'yyyy-MM-dd');
    if (c === 'deCaja') o[c] = !(v === false || String(v).toLowerCase() === 'false' || String(v).toLowerCase() === 'no');
    else if (c === 'pagoDueno') { if (v === true || String(v).toLowerCase() === 'true') o[c] = true; }
    else o[c] = NUMERICOS.indexOf(c) >= 0 ? Number(v) || 0 : String(v);
  });
  return o;
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
    if (!r) return null;
    const borrado = filaAObjeto(h.getRange(r, 1, 1, COLUMNAS.length).getValues()[0]);
    h.deleteRow(r);
    return { accion: 'borrado', m: borrado };
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
  return { accion: r ? 'cambio' : 'nuevo', m: Object.assign({}, m, { pagoDueno: o.pagoDueno === true }) };
}

/* ---------- avisos para el dueño ---------- */
const NOMBRE_TIPO = { ingreso: 'entrada', gasto: 'gasto', adeudo: 'deuda de chofer', abono: 'pago de deuda',
  reparacion: 'reparación', inicial: 'saldo inicial', reembolso: 'recuperación del dueño' };
function pesos(n) {
  const v = Math.round(Number(n || 0) * 100) / 100, partes = Math.abs(v).toFixed(2).split('.');
  return (v < 0 ? '-' : '') + '$' + partes[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',') + '.' + partes[1];
}
function describir(h) {
  const m = h.m, f = String(m.fecha || '').split('-');
  const verbo = { nuevo: 'Registró', cambio: 'Cambió', borrado: 'Borró' }[h.accion];
  const extra = [m.categoria, m.chofer ? 'chofer ' + m.chofer : '', m.pagoDueno ? 'pagado por el dueño' : '',
    f.length === 3 ? f[2] + '/' + f[1] : ''].filter(Boolean);
  return verbo + ' ' + (NOMBRE_TIPO[m.tipo] || 'movimiento') + ' de ' + pesos(m.monto) + (extra.length ? ' · ' + extra.join(' · ') : '');
}
function hojaAvisos() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let h = ss.getSheetByName('Avisos');
  if (!h) {
    h = ss.insertSheet('Avisos');
    h.getRange(1, 1, 1, 4).setValues([['id', 't', 'usuario', 'texto']]).setFontWeight('bold');
    h.setFrozenRows(1);
  }
  return h;
}
function avisar(s, hechos) {
  const h = hojaAvisos();
  const a = { id: Utilities.getUuid().slice(0, 8), t: new Date().toISOString(), usuario: s.usuario,
    texto: hechos.map(describir).join('\n') };
  h.appendRow([a.id, celda(a.t), celda(a.usuario), celda(a.texto)]);
  if (h.getLastRow() > 600) h.deleteRows(2, 100);
  enviarPush();
  return a;
}
function leerAvisos() {
  const h = hojaAvisos(), n = h.getLastRow();
  if (n < 2) return [];
  const desde = Math.max(2, n - 29);
  return h.getRange(desde, 1, n - desde + 1, 4).getValues()
    .map(r => ({ id: String(r[0]), t: r[1] instanceof Date ? r[1].toISOString() : String(r[1]), usuario: String(r[2]), texto: String(r[3]) }))
    .reverse();
}
function conAvisos(out, s) { if (s.rol === 'dueno' && out.ok) out.avisos = leerAvisos(); return out; }

/* ---------- notificaciones Web Push ----------
   Se mandan sin contenido (así no hace falta cifrarlo); el teléfono, al recibirla, pide el último aviso.
   Las firma una llave VAPID (ECDSA P-256) que se genera aquí la primera vez y vive en las propiedades del script. */
const P256 = {
  p: BigInt('0xffffffff00000001000000000000000000000000ffffffffffffffffffffffff'),
  n: BigInt('0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551'),
  G: [BigInt('0x6b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c296'),
      BigInt('0x4fe342e2fe1a7f9b8ee7eb4a7c0f9e162bce33576b315ececbb6406837bf51f5'), BigInt(1)]
};
function modp(a, m) { const r = a % m; return r < BigInt(0) ? r + m : r; }
function powMod(b, e, m) {
  let r = BigInt(1); b = modp(b, m);
  while (e > BigInt(0)) { if (e & BigInt(1)) r = r * b % m; b = b * b % m; e >>= BigInt(1); }
  return r;
}
const invMod = (a, m) => powMod(a, m - BigInt(2), m);
// Puntos en coordenadas jacobianas [X, Y, Z]; Z = 0 es el punto al infinito
function ecDoble(P) {
  const p = P256.p, X1 = P[0], Y1 = P[1], Z1 = P[2];
  if (Z1 === BigInt(0) || Y1 === BigInt(0)) return [BigInt(0), BigInt(1), BigInt(0)];
  const delta = Z1 * Z1 % p, gamma = Y1 * Y1 % p, beta = X1 * gamma % p;
  const alpha = BigInt(3) * modp((X1 - delta) * (X1 + delta), p) % p;
  const X3 = modp(alpha * alpha - BigInt(8) * beta, p);
  const Z3 = modp((Y1 + Z1) * (Y1 + Z1) - gamma - delta, p);
  const Y3 = modp(alpha * (BigInt(4) * beta - X3) - BigInt(8) * gamma * gamma, p);
  return [X3, Y3, Z3];
}
function ecSuma(P, Q) {
  const p = P256.p;
  if (P[2] === BigInt(0)) return Q;
  if (Q[2] === BigInt(0)) return P;
  const Z1Z1 = P[2] * P[2] % p, Z2Z2 = Q[2] * Q[2] % p;
  const U1 = P[0] * Z2Z2 % p, U2 = Q[0] * Z1Z1 % p;
  const S1 = P[1] * Q[2] % p * Z2Z2 % p, S2 = Q[1] * P[2] % p * Z1Z1 % p;
  const H = modp(U2 - U1, p), r = modp(BigInt(2) * (S2 - S1), p);
  if (H === BigInt(0)) return r === BigInt(0) ? ecDoble(P) : [BigInt(0), BigInt(1), BigInt(0)];
  const I = BigInt(4) * H * H % p, J = H * I % p, V = U1 * I % p;
  const X3 = modp(r * r - J - BigInt(2) * V, p);
  const Y3 = modp(r * (V - X3) - BigInt(2) * S1 * J, p);
  const Z3 = modp(((P[2] + Q[2]) * (P[2] + Q[2]) - Z1Z1 - Z2Z2) * H, p);
  return [X3, Y3, Z3];
}
function ecMult(k, P) {
  let R = [BigInt(0), BigInt(1), BigInt(0)], Q = P;
  while (k > BigInt(0)) { if (k & BigInt(1)) R = ecSuma(R, Q); Q = ecDoble(Q); k >>= BigInt(1); }
  return R;
}
function ecAfin(P) {
  const p = P256.p, zi = invMod(P[2], p), zi2 = zi * zi % p;
  return [P[0] * zi2 % p, P[1] * zi2 % p * zi % p];
}
const aHex = bytes => bytes.map(b => ((b + 256) % 256).toString(16).padStart(2, '0')).join('');
const sha256Hex = txt => aHex(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, txt, Utilities.Charset.UTF_8));
const bytes32 = n => n.toString(16).padStart(64, '0').match(/../g).map(h => { const b = parseInt(h, 16); return b > 127 ? b - 256 : b; });
const b64url = bytes => Utilities.base64EncodeWebSafe(bytes).replace(/=+$/, '');
const b64urlTxt = txt => Utilities.base64EncodeWebSafe(txt, Utilities.Charset.UTF_8).replace(/=+$/, '');
// número al azar menor que n a partir de UUID v4 (que Java genera con SecureRandom)
function azarN(extra) {
  for (;;) {
    const k = BigInt('0x' + sha256Hex(Utilities.getUuid() + Utilities.getUuid() + Utilities.getUuid() + (extra || '')));
    if (k > BigInt(0) && k < P256.n) return k;
  }
}
function llavesVapid() {
  const k = leerJSON('VAPID');
  if (k.d && k.pub) return k;
  const d = azarN();
  const pub = ecAfin(ecMult(d, P256.G));
  const nuevas = { d: d.toString(16), pub: b64url([4].concat(bytes32(pub[0]), bytes32(pub[1]))) };
  props().setProperty('VAPID', JSON.stringify(nuevas));
  return nuevas;
}
function firmarES256(entrada, dHex) {
  const n = P256.n, d = BigInt('0x' + dHex), e = BigInt('0x' + sha256Hex(entrada)) % n;
  for (;;) {
    const k = azarN(dHex + entrada);
    const r = ecAfin(ecMult(k, P256.G))[0] % n;
    if (r === BigInt(0)) continue;
    const s = invMod(k, n) * modp(e + r * d, n) % n;
    if (s === BigInt(0)) continue;
    return b64url(bytes32(r).concat(bytes32(s)));
  }
}
// Encabezado Authorization de VAPID para el servicio de push del teléfono (se reutiliza unas horas)
function vapid(endpoint) {
  const aud = endpoint.match(/^https:\/\/[^/]+/)[0];
  const cache = CacheService.getScriptCache(), guardado = cache.get('vapid ' + aud);
  if (guardado) return guardado;
  const k = llavesVapid();
  const entrada = b64urlTxt(JSON.stringify({ typ: 'JWT', alg: 'ES256' })) + '.' +
    b64urlTxt(JSON.stringify({ aud: aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: 'https://christianmunoz1713.github.io/cuentas-camioneta/' }));
  const valor = 'vapid t=' + entrada + '.' + firmarES256(entrada, k.d) + ', k=' + k.pub;
  cache.put('vapid ' + aud, valor, 6 * 3600);
  return valor;
}
function enviarPush() {
  const subs = leerJSON('PUSH_SUBS'), resultados = [];
  let cambio = false;
  Object.keys(subs).forEach(ep => {
    try {
      const r = UrlFetchApp.fetch(ep, { method: 'post', payload: '', muteHttpExceptions: true,
        headers: { TTL: '86400', Urgency: 'high', Authorization: vapid(ep) } });
      const c = r.getResponseCode();
      resultados.push(c);
      // el teléfono ya no existe o quitó el permiso
      if (c === 404 || c === 410) { delete subs[ep]; cambio = true; }
    } catch (err) { resultados.push(String(err && err.message || err)); }
  });
  if (cambio) props().setProperty('PUSH_SUBS', JSON.stringify(subs));
  return resultados;
}
function suscribirPush(s, sub) {
  if (s.rol !== 'dueno') return { ok: false, error: 'Solo el dueño recibe las notificaciones.' };
  const ep = sub && String(sub.endpoint || '');
  if (!/^https:\/\/[a-z0-9.-]+\.(googleapis\.com|mozilla\.com|windows\.com|apple\.com)\//i.test(ep) || ep.length > 1000)
    return { ok: false, error: 'Este navegador no es compatible con las notificaciones.' };
  const subs = leerJSON('PUSH_SUBS');
  subs[ep] = { u: s.usuario, t: new Date().toISOString() };
  // como máximo 5 teléfonos: se quedan los más recientes
  const eps = Object.keys(subs).sort((a, b) => subs[b].t.localeCompare(subs[a].t));
  eps.slice(5).forEach(e => { delete subs[e]; });
  props().setProperty('PUSH_SUBS', JSON.stringify(subs));
  return { ok: true };
}
function quitarPush(endpoint) {
  const subs = leerJSON('PUSH_SUBS');
  delete subs[String(endpoint || '')];
  props().setProperty('PUSH_SUBS', JSON.stringify(subs));
  return { ok: true };
}
function probarPush(s) {
  if (s.rol !== 'dueno') return { ok: false, error: 'Solo el dueño recibe las notificaciones.' };
  const h = hojaAvisos();
  h.appendRow([Utilities.getUuid().slice(0, 8), celda(new Date().toISOString()), celda(s.usuario), celda('Prueba: así te van a llegar los avisos.')]);
  const r = enviarPush();
  return { ok: true, resultados: r, avisos: leerAvisos() };
}

/* ---------- menú en la hoja ---------- */
// Ejecútala una vez desde el editor para dar permiso de mandar notificaciones (UrlFetchApp)
function autorizar() {
  UrlFetchApp.fetch('https://www.google.com', { muteHttpExceptions: true });
  console.log('Llave pública de notificaciones: ' + llavesVapid().pub);
}

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
