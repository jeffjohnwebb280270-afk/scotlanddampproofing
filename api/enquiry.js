// Vercel serverless function — receives the request.html enquiry form and sends
// it on by SMTP.
//
// Sends through the site's own mailbox (IONOS by default) rather than a
// third-party API, so no extra SPF/DKIM records are needed: the mail leaves
// through the provider the domain's SPF already authorises.
//
// Required environment variables:
//   SMTP_USER  full mailbox address, e.g. contact@scotlanddampproofing.co.uk
//   SMTP_PASS  that mailbox's password
// Optional:
//   SMTP_HOST  defaults to smtp.ionos.co.uk
//   SMTP_PORT  defaults to 587 (STARTTLS). Use 465 for implicit TLS.
//   SMTP_TO    where enquiries land. Defaults to SMTP_USER.

const nodemailer = require('nodemailer');

const BUSINESS_NAME = 'Scotland Damp Proofing';

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function isValidEmail(email) {
  return typeof email === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
}
function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') { try { return JSON.parse(req.body); } catch (e) { return {}; } }
  return {};
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const data = readBody(req);

  // honeypot — bots that fill this get a silent success and no mail is sent
  if (data.hp) return res.status(200).json({ ok: true });

  const name = typeof data.name === 'string' ? data.name.trim() : '';
  const email = typeof data.email === 'string' ? data.email.trim() : '';
  const postcode = typeof data.postcode === 'string' ? data.postcode.trim() : '';

  if (!name || !email || !postcode) {
    return res.status(400).json({ error: 'Name, email and postcode are required.' });
  }
  if (!isValidEmail(email)) {
    return res.status(400).json({ error: 'Please provide a valid email address.' });
  }

  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;
  if (!user || !pass) {
    console.error('SMTP_USER / SMTP_PASS are not set');
    return res.status(500).json({ error: 'Server is not configured to send enquiries yet.' });
  }
  const host = process.env.SMTP_HOST || 'smtp.ionos.co.uk';
  const port = Number(process.env.SMTP_PORT || 587);
  const to = process.env.SMTP_TO || user;

  const signs = Array.isArray(data.signs) ? data.signs : [];
  const urgency = data.urgency || '';
  const isPriority = urgency === 'Investigation clock running';
  const subject = `${isPriority ? 'PRIORITY — ' : ''}New survey enquiry — ${name}`;

  const rows = [
    ['Name', name],
    ['Email', email],
    ['Phone', data.phone || ''],
    ['Postcode', postcode],
    ['Who they are', data.who || ''],
    ['Building type', data.type || ''],
    ['Building age', data.age || ''],
    ['What they are seeing', signs.join(', ')],
    ['Urgency', urgency],
    ['Notes', data.notes || ''],
  ];

  const html = `
    <div style="font-family:Arial,sans-serif;font-size:15px;color:#08121F;">
      ${isPriority ? '<p style="color:#8A2B1B;font-weight:bold;">PRIORITY — investigation clock running.</p>' : ''}
      <h2 style="margin:0 0 14px;">New website enquiry</h2>
      <table cellpadding="6" cellspacing="0" style="border-collapse:collapse;">
        ${rows.filter(([, v]) => v).map(([label, value]) =>
          `<tr><td style="font-weight:bold;vertical-align:top;padding-right:12px;">${escapeHtml(label)}</td><td>${escapeHtml(value).replace(/\n/g, '<br>')}</td></tr>`
        ).join('')}
      </table>
    </div>`;

  const text = rows.filter(([, v]) => v).map(([l, v]) => `${l}: ${v}`).join('\n');

  try {
    const transporter = nodemailer.createTransport({
      host,
      port,
      secure: port === 465, // 465 = implicit TLS, 587 = STARTTLS
      auth: { user, pass },
    });

    await transporter.sendMail({
      // must be the authenticated mailbox — providers reject anything else
      from: { name: `${BUSINESS_NAME} Website`, address: user },
      to,
      replyTo: { name: name || email, address: email },
      subject,
      text,
      html,
    });

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('Enquiry send error', err);
    return res.status(502).json({ error: 'Could not send your enquiry right now. Please call or email us directly.' });
  }
};
