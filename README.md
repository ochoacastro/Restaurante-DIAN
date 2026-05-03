# Backend Factura Electrónica DIAN 🧾

Servidor Node.js que conecta el POS del restaurante con la DIAN para emitir facturas electrónicas válidas.

---

## 📋 Requisitos PREVIOS (antes de usar este servidor)

### 1. Registro ante la DIAN
- Ingresa al portal: https://catalogo-vpfe-hab.dian.gov.co (pruebas)
- Registra tu empresa como **facturador electrónico**
- Registra tu **software** (te dan un Software ID y puedes poner el PIN)
- Descarga o solicita tu **certificado digital** (.p12 o .pfx)

### 2. Resolución de facturación
- Solicita en la DIAN una **resolución de facturación electrónica**
- Guarda el número de resolución, fecha, prefijo y rangos (ej: FE-1 al FE-5000)

---

## 🚀 Subir a Railway

### Paso 1 — Subir el código
1. Crea una cuenta en [GitHub](https://github.com) si no tienes
2. Crea un repositorio nuevo llamado `restaurante-dian`
3. Sube estos archivos: `server.js` y `package.json`
4. En Railway → New Project → Deploy from GitHub → elige ese repositorio

### Paso 2 — Configurar las variables
En Railway → tu proyecto → **Variables**, agrega:

| Variable | Valor |
|---|---|
| `DIAN_AMBIENTE` | `2` (pruebas) o `1` (producción) |
| `DIAN_SOFTWARE_ID` | El ID que te dio la DIAN |
| `DIAN_SOFTWARE_PIN` | El PIN que registraste |
| `CERT_BASE64` | Tu certificado .p12 en base64* |
| `CERT_PASSWORD` | Contraseña del certificado |
| `SMTP_HOST` | smtp.gmail.com |
| `SMTP_USER` | tucorreo@gmail.com |
| `SMTP_PASS` | App password de Gmail |
| `SMTP_FROM` | Mi Restaurante <correo@gmail.com> |

*Para convertir el certificado a base64 (en Mac/Linux):
```bash
base64 -i certificado.p12 | tr -d '\n'
```
En Windows (PowerShell):
```powershell
[Convert]::ToBase64String([IO.File]::ReadAllBytes("certificado.p12"))
```

### Paso 3 — Obtener la URL pública
1. En Railway → tu servicio → **Settings** → **Networking** → **Generate Domain**
2. Copia la URL (ej: `https://restaurante-dian-production-xxxx.up.railway.app`)
3. Pégala en el POS → Configuración → Factura Electrónica DIAN → URL del backend Railway

### Paso 4 — Probar conexión
- En el POS toca **"Probar conexión con backend"**
- Debe aparecer ✅ Backend conectado · PRUEBAS

---

## 🔌 Endpoints disponibles

| Método | Ruta | Descripción |
|---|---|---|
| GET | `/ping` | Verifica que el servidor esté activo |
| POST | `/emitir-factura` | Envía una factura a la DIAN |
| POST | `/nota-credito` | Emite una nota crédito (anulación) |
| POST | `/reenviar-email` | Reenvía la factura por correo |

---

## ⚠️ Importante

- En **ambiente 2 (pruebas)** las facturas NO tienen validez legal
- Debes completar el **set de habilitación** (30 facturas de prueba aprobadas por la DIAN) antes de pasar a producción
- El certificado digital tiene una vigencia (generalmente 3 años) — renuévalo antes de que venza

---

## 📞 Soporte DIAN
- Portal habilitación: https://catalogo-vpfe-hab.dian.gov.co
- Portal producción: https://catalogo-vpfe.dian.gov.co
- Línea DIAN: 57 (1) 7428973
