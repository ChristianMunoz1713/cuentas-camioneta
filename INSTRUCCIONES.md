# Cuentas de la Camioneta: puesta en marcha

App instalable (PWA). Los datos se guardan en una hoja de Google, así que el dueño y el administrador ven lo mismo desde sus teléfonos.

## Usuarios

| | Dueño | Administrador |
|---|---|---|
| Registrar, editar y borrar movimientos | ✓ | ✓ |
| Ver saldo, deudas, reparaciones y resumen | ✓ | ✓ |
| Crear o cambiar el usuario del administrador | ✓ | ✗ |

Nadie ve los datos sin iniciar sesión. Las contraseñas se guardan cifradas en el script de Google y nunca en el código.

## 1. Crear la hoja de Google (una sola vez)

1. En Google Drive crea una **hoja de cálculo** nueva, por ejemplo "Cuentas Camioneta".
2. Abre **Extensiones → Apps Script**, borra lo que haya y pega **todo** `google-apps-script/Codigo.gs`. Guarda.
3. Ve a **Implementar → Nueva implementación**, elige **Aplicación web** y configura:
   - Ejecutar como: **Yo**
   - Quién tiene acceso: **Cualquier persona**
4. Copia la URL que termina en `/exec` y pégala en `config.js` (`apiUrl: '...'`). Después vuelve a publicar la app.

> Si cambias el código del script: **Implementar → Gestionar implementaciones → Editar → Versión nueva**. La URL no cambia.

## 2. Primer inicio de sesión (dueño)

Abre la app y escribe el usuario y la contraseña que quieras (mínimo 8 caracteres). La app pide un **código de instalación**, que aparece en la pestaña "Instalación" de la hoja. Al entrar, ese usuario queda como **Dueño** y la pestaña se borra sola.

## 3. Crear al administrador

En la app, ve a **Ajustes → Usuario del administrador**. Escribe el usuario y la contraseña de tu administrador y pásaselos.

## 4. Instalar en el teléfono

- **Android (Chrome):** abre el enlace y toca **Instalar app** en Ajustes, o menú ⋮ → **Instalar app**.
- **iPhone (Safari):** toca Compartir → **Agregar a pantalla de inicio**.

## Seguridad

- Las sesiones duran 180 días. Si pierdes un teléfono, usa en la hoja **Camioneta → Cerrar todas las sesiones**.
- Si olvidas la contraseña del dueño, usa en la hoja **Camioneta → Olvidé la contraseña del dueño**. Los movimientos no se borran.
- Después de 5 intentos fallidos, el inicio de sesión se bloquea 15 minutos.
- No edites a mano la columna `id` de la hoja.

## Probar en la computadora

Ejecuta `node servidor.js` y abre http://localhost:8090. Usa datos de prueba en memoria; el código de instalación es `123456`.
