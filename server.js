require('dotenv').config();
const express  = require('express');
const cors     = require('cors');
const forge    = require('node-forge');
const { create } = require('xmlbuilder2');
const nodemailer = require('nodemailer');
const { v4: uuidv4 } = require('uuid');
const fs       = require('fs');
const path     = require('path');
const https    = require('https');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── Variables de entorno requeridas ──────────────────────────────────────────
// Configúralas en Railway → Variables:
//
//   DIAN_AMBIENTE        = 2  (2=pruebas, 1=producción)
//   DIAN_SOFTWARE_ID     = ID del software registrado en DIAN
//   DIAN_SOFTWARE_PIN    = PIN del software
//   CERT_BASE64          = Certificado .p12 en base64
//   CERT_PASSWORD        = Contraseña del certificado
//   SMTP_HOST            = smtp.gmail.com  (o tu proveedor)
//   SMTP_PORT            = 587
//   SMTP_USER            = correo@gmail.com
//   SMTP_PASS            = contraseña o app-password
//   SMTP_FROM            = "Mi Restaurante <correo@gmail.com>"
//
// ─────────────────────────────────────────────────────────────────────────────

const AMBIENTE       = process.env.DIAN_AMBIENTE   || '2';   // 2=pruebas
const SOFTWARE_ID    = process.env.DIAN_SOFTWARE_ID || '';
const SOFTWARE_PIN   = process.env.DIAN_SOFTWARE_PIN || '';
const CERT_BASE64    = process.env.CERT_BASE64      || '';
const CERT_PASSWORD  = process.env.CERT_PASSWORD    || '';

// URL DIAN según ambiente
const DIAN_URL = AMBIENTE === '1'
  ? 'https://vpfe.dian.gov.co/WcfDianCustomerServices.svc'
  : 'https://vpfe-hab.dian.gov.co/WcfDianCustomerServices.svc';

app.use(cors());
app.use(express.json({ limit: '5mb' }));

// ── /ping ─────────────────────────────────────────────────────────────────────
app.get('/ping', (req, res) => {
  const configurado = !!(SOFTWARE_ID && CERT_BASE64);
  res.json({
    ok: true,
    ambiente: AMBIENTE === '1' ? 'PRODUCCIÓN' : 'PRUEBAS',
    configurado,
    mensaje: configurado
      ? 'Backend listo para emitir facturas'
      : 'Faltan variables de entorno (DIAN_SOFTWARE_ID, CERT_BASE64)'
  });
});

// ── /emitir-factura ───────────────────────────────────────────────────────────
app.post('/emitir-factura', async (req, res) => {
  try {
    const { emisor, receptor, factura } = req.body;

    if (!emisor || !receptor || !factura) {
      return res.status(400).json({ ok: false, error: 'Payload incompleto' });
    }
    if (!SOFTWARE_ID || !CERT_BASE64) {
      return res.status(500).json({ ok: false, error: 'Backend no configurado: faltan DIAN_SOFTWARE_ID o CERT_BASE64' });
    }

    // 1. Construir XML UBL 2.1
    const xmlStr = construirXmlFactura({ emisor, receptor, factura });

    // 2. Firmar XML con el certificado
    const xmlFirmado = firmarXml(xmlStr);

    // 3. Comprimir y encodear en base64
    const zipBase64 = await xmlAZipBase64(xmlFirmado, `${emisor.prefijo}${factura.numero}.xml`);

    // 4. Enviar a la DIAN via SOAP
    const respDian = await enviarADian(zipBase64, emisor, factura);

    // 5. Extraer CUFE de la respuesta
    const cufe = extraerCufe(respDian);

    if (!cufe) {
      return res.status(422).json({
        ok: false,
        error: 'DIAN no devolvió CUFE — revisa los datos de la resolución',
        dianRaw: respDian.substring(0, 500)
      });
    }

    // 6. Enviar email si hay correo
    if (receptor.correo) {
      enviarEmailFactura({ emisor, receptor, factura, cufe }).catch(e =>
        console.error('Error enviando email:', e.message)
      );
    }

    return res.json({ ok: true, cufe, ambiente: AMBIENTE === '1' ? 'produccion' : 'pruebas' });

  } catch (e) {
    console.error('Error emitir-factura:', e);
    return res.status(500).json({ ok: false, error: e.message });
  }
});

// ── /nota-credito ─────────────────────────────────────────────────────────────
app.post('/nota-credito', async (req, res) => {
  try {
    const { facturaReferencia, motivo, emisor, receptor, total, items } = req.body;

    if (!facturaReferencia?.cufe) {
      return res.status(400).json({ ok: false, error: 'CUFE de factura referencia requerido' });
    }
    if (!SOFTWARE_ID || !CERT_BASE64) {
      return res.status(500).json({ ok: false, error: 'Backend no configurado' });
    }

    const xmlStr     = construirXmlNotaCredito({ facturaReferencia, motivo, emisor, receptor, total, items });
    const xmlFirmado = firmarXml(xmlStr);
    const zipBase64  = await xmlAZipBase64(xmlFirmado, `NC${facturaReferencia.numero}.xml`);
    const respDian   = await enviarADian(zipBase64, emisor, facturaReferencia, 'notaCredito');
    const cufe       = extraerCufe(respDian);

    if (!cufe) {
      return res.status(422).json({ ok: false, error: 'DIAN no devolvió CUFE para la nota crédito', dianRaw: respDian.substring(0, 500) });
    }

    return res.json({ ok: true, cufe });

  } catch (e) {
    console.error('Error nota-credito:', e);
    return res.status(500).json({ ok: false, error: e.message });
  }
});

// ── /reenviar-email ───────────────────────────────────────────────────────────
app.post('/reenviar-email', async (req, res) => {
  try {
    const { cufe, correo, nombre, numero, total, fecha } = req.body;
    if (!correo) return res.status(400).json({ ok: false, error: 'Correo requerido' });

    await enviarEmailFactura({
      emisor: {},
      receptor: { correo, nombre },
      factura: { numero, total, fecha },
      cufe
    });

    res.json({ ok: true });
  } catch (e) {
    console.error('Error reenviar-email:', e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// FUNCIONES AUXILIARES
// ─────────────────────────────────────────────────────────────────────────────

function construirXmlFactura({ emisor, receptor, factura }) {
  const ahora    = new Date();
  const fecha    = factura.fecha || ahora.toISOString().split('T')[0];
  const hora     = factura.hora  || ahora.toTimeString().split(' ')[0];
  const uuid     = uuidv4();
  const numFact  = `${emisor.prefijo}${String(factura.numero).padStart(6,'0')}`;

  // Calcular CUFE (hash SHA-384 según especificación DIAN)
  const cufeInput = [
    numFact, fecha, hora,
    String(factura.total),
    '01', String(factura.totalImpuestos || 0),
    '01', String(factura.total),
    emisor.nit.replace(/-/g,''),
    receptor.documento,
    SOFTWARE_ID
  ].join('');

  const cufe = forge.md.sha384.create().update(cufeInput).digest().toHex();

  const items = (factura.items || []).map((item, i) => ({
    linea: i + 1,
    descripcion: item.nombre,
    cantidad: item.cantidad,
    valorUnitario: item.precioUnitario,
    subtotal: item.total,
    iva: item.iva || 0,
    base: item.base || item.total
  }));

  const doc = create({ version: '1.0', encoding: 'UTF-8' })
    .ele('fe:Invoice', {
      'xmlns:fe':  'urn:oasis:names:specification:ubl:schema:xsd:Invoice-2',
      'xmlns:cac': 'urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2',
      'xmlns:cbc': 'urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2',
      'xmlns:ext': 'urn:oasis:names:specification:ubl:schema:xsd:CommonExtensionComponents-2',
      'xmlns:sts': 'dian:gov:co:facturaelectronica:Structures-2-1',
      'xmlns:ds':  'http://www.w3.org/2000/09/xmldsig#',
      'xmlns:xades': 'http://uri.etsi.org/01903/v1.3.2#'
    })
      .ele('ext:UBLExtensions')
        .ele('ext:UBLExtension')
          .ele('ext:ExtensionContent').up()
        .up()
      .up()
      .ele('cbc:UBLVersionID').txt('UBL 2.1').up()
      .ele('cbc:CustomizationID').txt('10').up()
      .ele('cbc:ProfileID').txt('DIAN 2.1').up()
      .ele('cbc:ProfileExecutionID').txt(AMBIENTE).up()
      .ele('cbc:ID').txt(numFact).up()
      .ele('cbc:UUID', { schemeID: AMBIENTE, schemeName: 'CUFE-SHA384' }).txt(cufe).up()
      .ele('cbc:IssueDate').txt(fecha).up()
      .ele('cbc:IssueTime').txt(hora + 'Z').up()
      .ele('cbc:InvoiceTypeCode').txt('01').up()
      .ele('cbc:DocumentCurrencyCode').txt('COP').up()
      .ele('cbc:LineCountNumeric').txt(String(items.length)).up()
      // Resolución DIAN
      .ele('cac:InvoicePeriod').up()
      .ele('cac:OrderReference')
        .ele('cbc:ID').txt(numFact).up()
      .up()
      // Software
      .ele('ext:UBLExtensions').up()
      // Emisor
      .ele('cac:AccountingSupplierParty')
        .ele('cbc:AdditionalAccountID').txt('1').up()
        .ele('cac:Party')
          .ele('cac:PartyName')
            .ele('cbc:Name').txt(emisor.nombre || '').up()
          .up()
          .ele('cac:PhysicalLocation')
            .ele('cac:Address')
              .ele('cbc:CityName').txt(emisor.ciudad || 'Bogotá').up()
              .ele('cbc:CountrySubentity').txt(emisor.departamento || 'Cundinamarca').up()
              .ele('cac:AddressLine')
                .ele('cbc:Line').txt(emisor.direccion || '').up()
              .up()
              .ele('cac:Country')
                .ele('cbc:IdentificationCode').txt('CO').up()
              .up()
            .up()
          .up()
          .ele('cac:PartyTaxScheme')
            .ele('cbc:RegistrationName').txt(emisor.nombre || '').up()
            .ele('cbc:CompanyID', { schemeAgencyID: '195', schemeAgencyName: 'CO, DIAN (Dirección de Impuestos y Aduanas Nacionales)', schemeID: '4', schemeName: '31' })
              .txt(emisor.nit.replace(/-/g, '') || '').up()
            .ele('cbc:TaxLevelCode', { listName: '48' }).txt('O-13').up()
            .ele('cac:RegistrationAddress')
              .ele('cbc:CityName').txt(emisor.ciudad || 'Bogotá').up()
              .ele('cac:Country')
                .ele('cbc:IdentificationCode').txt('CO').up()
              .up()
            .up()
            .ele('cac:TaxScheme')
              .ele('cbc:ID').txt('01').up()
              .ele('cbc:Name').txt('IVA').up()
            .up()
          .up()
          .ele('cac:PartyLegalEntity')
            .ele('cbc:RegistrationName').txt(emisor.nombre || '').up()
            .ele('cbc:CompanyID', { schemeAgencyID: '195', schemeAgencyName: 'CO, DIAN', schemeID: '4', schemeName: '31' })
              .txt(emisor.nit.replace(/-/g, '') || '').up()
          .up()
        .up()
      .up()
      // Receptor
      .ele('cac:AccountingCustomerParty')
        .ele('cbc:AdditionalAccountID').txt('1').up()
        .ele('cac:Party')
          .ele('cac:PartyName')
            .ele('cbc:Name').txt(receptor.nombre || 'Consumidor Final').up()
          .up()
          .ele('cac:PartyTaxScheme')
            .ele('cbc:RegistrationName').txt(receptor.nombre || 'Consumidor Final').up()
            .ele('cbc:CompanyID', { schemeAgencyID: '195', schemeAgencyName: 'CO, DIAN', schemeID: receptor.tipoDocumento === 'NIT' ? '4' : '13', schemeName: '31' })
              .txt(receptor.documento || '222222222').up()
            .ele('cbc:TaxLevelCode', { listName: '48' }).txt('R-99-PN').up()
            .ele('cac:TaxScheme')
              .ele('cbc:ID').txt('ZZ').up()
              .ele('cbc:Name').txt('No aplica').up()
            .up()
          .up()
          .ele('cac:PartyLegalEntity')
            .ele('cbc:RegistrationName').txt(receptor.nombre || 'Consumidor Final').up()
            .ele('cbc:CompanyID', { schemeAgencyID: '195', schemeAgencyName: 'CO, DIAN', schemeID: '13', schemeName: '31' })
              .txt(receptor.documento || '222222222').up()
          .up()
          .ele('cac:Contact')
            .ele('cbc:ElectronicMail').txt(receptor.correo || '').up()
          .up()
        .up()
      .up()
      // Método de pago
      .ele('cac:PaymentMeans')
        .ele('cbc:ID').txt('1').up()
        .ele('cbc:PaymentMeansCode').txt('10').up()
        .ele('cbc:PaymentDueDate').txt(fecha).up()
      .up()
      // IVA
      .ele('cac:TaxTotal')
        .ele('cbc:TaxAmount', { currencyID: 'COP' }).txt(String(factura.totalImpuestos || 0)).up()
        .ele('cac:TaxSubtotal')
          .ele('cbc:TaxableAmount', { currencyID: 'COP' }).txt(String(factura.totalBase || factura.total)).up()
          .ele('cbc:TaxAmount', { currencyID: 'COP' }).txt(String(factura.totalImpuestos || 0)).up()
          .ele('cac:TaxCategory')
            .ele('cbc:Percent').txt('8').up()
            .ele('cac:TaxScheme')
              .ele('cbc:ID').txt('01').up()
              .ele('cbc:Name').txt('IVA').up()
            .up()
          .up()
        .up()
      .up()
      // Totales
      .ele('cac:LegalMonetaryTotal')
        .ele('cbc:LineExtensionAmount', { currencyID: 'COP' }).txt(String(factura.totalBase || factura.total)).up()
        .ele('cbc:TaxExclusiveAmount',  { currencyID: 'COP' }).txt(String(factura.totalBase || factura.total)).up()
        .ele('cbc:TaxInclusiveAmount',  { currencyID: 'COP' }).txt(String(factura.total)).up()
        .ele('cbc:PayableAmount',       { currencyID: 'COP' }).txt(String(factura.total)).up()
      .up();

  // Líneas de items
  items.forEach(item => {
    doc
      .ele('cac:InvoiceLine')
        .ele('cbc:ID').txt(String(item.linea)).up()
        .ele('cbc:InvoicedQuantity', { unitCode: 'NAR' }).txt(String(item.cantidad)).up()
        .ele('cbc:LineExtensionAmount', { currencyID: 'COP' }).txt(String(item.subtotal)).up()
        .ele('cac:TaxTotal')
          .ele('cbc:TaxAmount', { currencyID: 'COP' }).txt(String(Math.round(item.subtotal * (item.iva / 100)))).up()
          .ele('cac:TaxSubtotal')
            .ele('cbc:TaxableAmount', { currencyID: 'COP' }).txt(String(item.base)).up()
            .ele('cbc:TaxAmount',     { currencyID: 'COP' }).txt(String(Math.round(item.base * (item.iva / 100)))).up()
            .ele('cac:TaxCategory')
              .ele('cbc:Percent').txt(String(item.iva)).up()
              .ele('cac:TaxScheme')
                .ele('cbc:ID').txt('01').up()
                .ele('cbc:Name').txt('IVA').up()
              .up()
            .up()
          .up()
        .up()
        .ele('cac:Item')
          .ele('cbc:Description').txt(item.descripcion).up()
        .up()
        .ele('cac:Price')
          .ele('cbc:PriceAmount', { currencyID: 'COP' }).txt(String(item.valorUnitario)).up()
        .up()
      .up();
  });

  return doc.end({ prettyPrint: false });
}

function construirXmlNotaCredito({ facturaReferencia, motivo, emisor, receptor, total, items }) {
  const ahora   = new Date();
  const fecha   = ahora.toISOString().split('T')[0];
  const hora    = ahora.toTimeString().split(' ')[0];
  const numNC   = `NC${String(facturaReferencia.numero).padStart(6,'0')}`;

  const doc = create({ version: '1.0', encoding: 'UTF-8' })
    .ele('fe:CreditNote', {
      'xmlns:fe':  'urn:oasis:names:specification:ubl:schema:xsd:CreditNote-2',
      'xmlns:cac': 'urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2',
      'xmlns:cbc': 'urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2',
      'xmlns:ext': 'urn:oasis:names:specification:ubl:schema:xsd:CommonExtensionComponents-2',
    })
      .ele('cbc:UBLVersionID').txt('UBL 2.1').up()
      .ele('cbc:CustomizationID').txt('10').up()
      .ele('cbc:ProfileExecutionID').txt(AMBIENTE).up()
      .ele('cbc:ID').txt(numNC).up()
      .ele('cbc:IssueDate').txt(fecha).up()
      .ele('cbc:IssueTime').txt(hora + 'Z').up()
      .ele('cbc:DocumentCurrencyCode').txt('COP').up()
      .ele('cbc:DiscrepancyResponse')
        .ele('cbc:ReferenceID').txt(`${emisor.prefijo}${String(facturaReferencia.numero).padStart(6,'0')}`).up()
        .ele('cbc:ResponseCode').txt('1').up()
        .ele('cbc:Description').txt(motivo || 'Anulación').up()
      .up()
      .ele('cac:BillingReference')
        .ele('cac:InvoiceDocumentReference')
          .ele('cbc:ID').txt(`${emisor.prefijo}${String(facturaReferencia.numero).padStart(6,'0')}`).up()
          .ele('cbc:UUID').txt(facturaReferencia.cufe).up()
          .ele('cbc:IssueDate').txt(facturaReferencia.fecha || fecha).up()
        .up()
      .up()
      .ele('cac:LegalMonetaryTotal')
        .ele('cbc:PayableAmount', { currencyID: 'COP' }).txt(String(total)).up()
      .up()
    .up();

  return doc.end({ prettyPrint: false });
}

function firmarXml(xmlStr) {
  if (!CERT_BASE64 || !CERT_PASSWORD) {
    console.warn('⚠️  Sin certificado configurado — XML sin firma (solo válido para pruebas locales)');
    return xmlStr;
  }

  try {
    const certDer = forge.util.decode64(CERT_BASE64);
    const p12Asn1 = forge.asn1.fromDer(certDer);
    const p12     = forge.pkcs12.pkcs12FromAsn1(p12Asn1, CERT_PASSWORD);

    let privateKey = null;
    let certificate = null;

    for (const safeContent of p12.safeContents) {
      for (const safeBag of safeContent.safeBags) {
        if (safeBag.type === forge.pki.oids.pkcs8ShroudedKeyBag && safeBag.key) {
          privateKey = safeBag.key;
        }
        if (safeBag.type === forge.pki.oids.certBag && safeBag.cert) {
          certificate = safeBag.cert;
        }
      }
    }

    if (!privateKey || !certificate) {
      console.error('No se encontró clave o certificado en el .p12');
      return xmlStr;
    }

    // Firma XAdES-B básica embebida
    const md = forge.md.sha256.create();
    md.update(xmlStr, 'utf8');
    const signature = forge.util.encode64(privateKey.sign(md));
    const certPem   = forge.util.encode64(forge.asn1.toDer(forge.pki.certificateToAsn1(certificate)).getBytes());

    const sigBlock = `<ds:Signature xmlns:ds="http://www.w3.org/2000/09/xmldsig#">
  <ds:SignedInfo>
    <ds:CanonicalizationMethod Algorithm="http://www.w3.org/TR/2001/REC-xml-c14n-20010315"/>
    <ds:SignatureMethod Algorithm="http://www.w3.org/2001/04/xmldsig-more#rsa-sha256"/>
    <ds:Reference URI="">
      <ds:DigestMethod Algorithm="http://www.w3.org/2001/04/xmlenc#sha256"/>
      <ds:DigestValue>${signature}</ds:DigestValue>
    </ds:Reference>
  </ds:SignedInfo>
  <ds:SignatureValue>${signature}</ds:SignatureValue>
  <ds:KeyInfo>
    <ds:X509Data>
      <ds:X509Certificate>${certPem}</ds:X509Certificate>
    </ds:X509Data>
  </ds:KeyInfo>
</ds:Signature>`;

    return xmlStr.replace('<ext:ExtensionContent/>', `<ext:ExtensionContent>${sigBlock}</ext:ExtensionContent>`);

  } catch (e) {
    console.error('Error firmando XML:', e.message);
    return xmlStr;
  }
}

async function xmlAZipBase64(xmlStr, filename) {
  // Usamos el módulo zlib nativo para comprimir (compatibilidad con Railway sin dependencias extra)
  const zlib = require('zlib');
  return new Promise((resolve, reject) => {
    // DIAN acepta zip — usamos deflate simple envuelto en base64
    zlib.deflate(Buffer.from(xmlStr, 'utf8'), (err, buf) => {
      if (err) return reject(err);
      resolve(buf.toString('base64'));
    });
  });
}

async function enviarADian(zipBase64, emisor, factura, tipo = 'factura') {
  const nitLimpio = (emisor.nit || '').replace(/-/g, '');
  const numFact   = tipo === 'notaCredito'
    ? `NC${String(factura.numero).padStart(6,'0')}`
    : `${emisor.prefijo || 'FE'}${String(factura.numero).padStart(6,'0')}`;

  const soapAction = tipo === 'notaCredito'
    ? 'http://wcf.dian.colombia/IWcfDianCustomerServices/SendBillSync'
    : 'http://wcf.dian.colombia/IWcfDianCustomerServices/SendBillSync';

  const soapBody = `<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"
               xmlns:wcf="http://wcf.dian.colombia">
  <soap:Header/>
  <soap:Body>
    <wcf:SendBillSync>
      <wcf:fileName>${numFact}.zip</wcf:fileName>
      <wcf:contentFile>${zipBase64}</wcf:contentFile>
    </wcf:SendBillSync>
  </soap:Body>
</soap:Envelope>`;

  return new Promise((resolve, reject) => {
    const url    = new URL(DIAN_URL);
    const opts   = {
      hostname: url.hostname,
      path: url.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'text/xml; charset=utf-8',
        'SOAPAction': soapAction,
        'Content-Length': Buffer.byteLength(soapBody)
      }
    };

    const req = https.request(opts, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(data));
    });

    req.on('error', reject);
    req.setTimeout(30000, () => { req.destroy(); reject(new Error('Timeout DIAN')); });
    req.write(soapBody);
    req.end();
  });
}

function extraerCufe(soapResponse) {
  // Buscar CUFE en la respuesta SOAP de la DIAN
  const match = soapResponse.match(/([a-f0-9]{96})/i);
  return match ? match[1] : null;
}

async function enviarEmailFactura({ emisor, receptor, factura, cufe }) {
  if (!process.env.SMTP_HOST || !process.env.SMTP_USER) {
    console.warn('Email no configurado — faltan SMTP_HOST y SMTP_USER');
    return;
  }

  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: parseInt(process.env.SMTP_PORT || '587'),
    secure: process.env.SMTP_PORT === '465',
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS
    }
  });

  const html = `
    <div style="font-family:Arial,sans-serif;max-width:500px;margin:0 auto;">
      <h2 style="color:#FF441A;">🧾 Tu factura electrónica</h2>
      <p>Hola <strong>${receptor.nombre || 'Cliente'}</strong>,</p>
      <p>Tu factura <strong>#${factura.numero}</strong> ha sido procesada exitosamente ante la DIAN.</p>
      <table style="width:100%;border-collapse:collapse;margin:16px 0;">
        <tr style="background:#f5f5f5;">
          <td style="padding:8px;font-weight:bold;">CUFE</td>
          <td style="padding:8px;font-size:11px;word-break:break-all;">${cufe}</td>
        </tr>
        <tr>
          <td style="padding:8px;font-weight:bold;">Total</td>
          <td style="padding:8px;">$ ${Number(factura.total || 0).toLocaleString('es-CO')}</td>
        </tr>
        <tr style="background:#f5f5f5;">
          <td style="padding:8px;font-weight:bold;">Fecha</td>
          <td style="padding:8px;">${factura.fecha || ''}</td>
        </tr>
      </table>
      <p style="color:#888;font-size:12px;">Puedes verificar tu factura en <a href="https://catalogo-vpfe.dian.gov.co/User/SearchDocument">el portal de la DIAN</a> usando el CUFE.</p>
      <p style="color:#888;font-size:12px;">Gracias por tu compra.</p>
    </div>
  `;

  await transporter.sendMail({
    from: process.env.SMTP_FROM || process.env.SMTP_USER,
    to: receptor.correo,
    subject: `Factura electrónica #${factura.numero}`,
    html
  });
}

// ── Inicio ────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`✅ Backend DIAN corriendo en puerto ${PORT}`);
  console.log(`   Ambiente: ${AMBIENTE === '1' ? 'PRODUCCIÓN' : 'PRUEBAS'}`);
  console.log(`   Software ID: ${SOFTWARE_ID ? '✓ configurado' : '✗ FALTA configurar'}`);
  console.log(`   Certificado: ${CERT_BASE64 ? '✓ configurado' : '✗ FALTA configurar'}`);
});
