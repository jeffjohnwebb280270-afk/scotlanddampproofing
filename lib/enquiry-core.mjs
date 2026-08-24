/**
 * enquiry-core.mjs
 *
 * Pure logic for the survey-request form. No network, no process.env reads at
 * module scope, no Vercel types. Everything here is synchronous and testable.
 *
 * Transport is SMTP through the site's own mailbox (IONOS by default) — the
 * provider the domain's SPF already authorises — so no third-party sender
 * needs SPF/DKIM records and there is no second supplier to hold an account
 * with. See commit 8a0313b.
 */

/* ------------------------------------------------------------------ *
 * Limits
 * ------------------------------------------------------------------ */

export const LIMITS = Object.freeze({
  name: 120,
  email: 254, // RFC 5321 practical maximum
  phone: 40,
  postcode: 12,
  notes: 4000,
  who: 80,
  type: 80,
  age: 80,
  urgency: 80,
  sign: 60,
  signsCount: 24,
});

/* ------------------------------------------------------------------ *
 * Config
 * ------------------------------------------------------------------ */

/**
 * Resolve runtime configuration from an environment object.
 *
 * Returns { ok, config, missing, warnings }. Never throws, never logs, and
 * never puts the mailbox password into the returned strings.
 *
 * @param {Record<string, string|undefined>} env
 */
export function resolveConfig(env = {}) {
  const missing = [];
  const warnings = [];

  const user = str(env.SMTP_USER);
  const pass = str(env.SMTP_PASS);

  if (!user) missing.push('SMTP_USER');
  else if (!isEmail(user)) missing.push('SMTP_USER (present but not a valid mailbox address)');
  if (!pass) missing.push('SMTP_PASS');

  // A Brevo key sitting in SMTP_PASS is a plausible leftover from the previous
  // transport, and authenticates against nothing here. Worth naming, because
  // the resulting 535 reads like an outage rather than a wrong credential.
  if (pass && /^(xkeysib|xsmtpsib)-/.test(pass)) {
    warnings.push('SMTP_PASS looks like a Brevo API key, not the mailbox password.');
  }

  const host = str(env.SMTP_HOST) || 'smtp.ionos.co.uk';
  const port = int(env.SMTP_PORT, 587, 1, 65535);
  if (port !== 587 && port !== 465) {
    warnings.push(`SMTP_PORT is ${port}; expected 587 (STARTTLS) or 465 (implicit TLS).`);
  }

  const toEmail = str(env.SMTP_TO) || str(env.ENQUIRY_TO_EMAIL) || user;
  if (toEmail && !isEmail(toEmail)) {
    missing.push('SMTP_TO (present but not a valid address)');
  }

  // The From address MUST be the authenticated mailbox — IONOS, like every
  // other provider, rejects a sender it did not authenticate. The enquirer
  // goes in Reply-To instead, so hitting reply answers the customer.
  const fromEmail = user;
  const declaredFrom = str(env.ENQUIRY_FROM_EMAIL);
  if (declaredFrom && declaredFrom.toLowerCase() !== user.toLowerCase()) {
    warnings.push(
      `ENQUIRY_FROM_EMAIL (${declaredFrom}) is ignored: From must be the authenticated mailbox, so ${user} is used.`,
    );
  }

  const fromName = str(env.ENQUIRY_FROM_NAME) || 'Scotland Damp Proofing Website';
  const siteName = str(env.ENQUIRY_SITE_NAME) || 'Scotland Damp Proofing';
  const replyPhone = str(env.ENQUIRY_PHONE) || '07446 522034';

  return {
    ok: missing.length === 0,
    missing,
    warnings,
    config: {
      host,
      port,
      secure: port === 465,
      user,
      pass,
      toEmail,
      fromEmail,
      fromName,
      siteName,
      replyPhone,
      sendAck: str(env.ENQUIRY_SEND_ACK) === '1',
      timeoutMs: int(env.ENQUIRY_TIMEOUT_MS, 10_000, 1_000, 30_000),
      maxAttempts: int(env.ENQUIRY_MAX_ATTEMPTS, 3, 1, 5),
    },
  };
}

/* ------------------------------------------------------------------ *
 * Validation
 * ------------------------------------------------------------------ */

/**
 * Validate and normalise a raw form payload.
 *
 * @param {unknown} raw
 * @returns {{ok:true, lead:object} | {ok:false, errors:string[]}}
 */
export function validateEnquiry(raw) {
  const errors = [];

  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, errors: ['Request body must be a JSON object.'] };
  }

  const name = trunc(str(raw.name), LIMITS.name);
  const email = trunc(str(raw.email), LIMITS.email).toLowerCase();
  const postcode = normalisePostcode(str(raw.postcode));

  if (!name) errors.push('name is required');
  if (!email) errors.push('email is required');
  else if (!isEmail(email)) errors.push('email is not a valid address');
  if (!postcode) errors.push('postcode is required');
  else if (!isUkPostcode(postcode)) errors.push('postcode does not look like a UK postcode');

  // `signs` is deliberately not whitelisted against a fixed vocabulary. The
  // front-end owns that list, and hard-coupling the two means adding a checkbox
  // to the form silently starts rejecting real enquiries. Cap count and length
  // instead — that bounds the abuse surface without the brittleness.
  let signs = [];
  if (Array.isArray(raw.signs)) {
    signs = raw.signs
      .filter((s) => typeof s === 'string')
      .map((s) => trunc(s.trim(), LIMITS.sign))
      .filter(Boolean)
      .slice(0, LIMITS.signsCount);
  } else if (raw.signs !== undefined && raw.signs !== null && raw.signs !== '') {
    errors.push('signs must be an array of strings');
  }

  if (errors.length) return { ok: false, errors };

  return {
    ok: true,
    lead: {
      name,
      email,
      postcode,
      phone: trunc(str(raw.phone), LIMITS.phone),
      notes: trunc(str(raw.notes), LIMITS.notes),
      who: trunc(str(raw.who), LIMITS.who),
      type: trunc(str(raw.type), LIMITS.type),
      age: trunc(str(raw.age), LIMITS.age),
      urgency: trunc(str(raw.urgency), LIMITS.urgency),
      signs,
    },
  };
}

/** Honeypot: the form ships a hidden `hp` input that humans never fill. */
export function isBot(raw) {
  return typeof raw?.hp === 'string' && raw.hp.trim() !== '';
}

/**
 * True when the enquiry should jump the queue: a landlord with a statutory
 * investigation clock running under the ICR(S) Regulations 2026, or any
 * suspected dry rot (which spreads through masonry between visits).
 */
export function isPriority(lead) {
  return (
    /clock running/i.test(lead.urgency || '') ||
    (lead.signs || []).includes('fungus')
  );
}

/* ------------------------------------------------------------------ *
 * Escaping
 * ------------------------------------------------------------------ */

const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/** Escape a string for interpolation into HTML text or a quoted attribute. */
export function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]);
}

/**
 * Strip CR/LF from a value destined for an email header (subject, display
 * name). Prevents header injection.
 */
export function escapeHeader(value) {
  return String(value ?? '')
    .replace(/[\r\n]+/g, ' ')
    .trim();
}

/* ------------------------------------------------------------------ *
 * Rendering
 * ------------------------------------------------------------------ */

const FIELD_LABELS = [
  ['who', 'Who they are'],
  ['type', 'Building type'],
  ['age', 'Building age'],
  ['urgency', 'Urgency'],
  ['postcode', 'Postcode'],
  ['phone', 'Phone'],
];

/** Build the nodemailer message for the internal notification email. */
export function buildNotificationEmail(lead, config, meta = {}) {
  const priority = isPriority(lead);
  const subject = escapeHeader(
    `${priority ? 'PRIORITY — ' : ''}New survey enquiry — ${lead.name}`,
  );

  const rows = FIELD_LABELS.filter(([k]) => lead[k])
    .map(
      ([k, label]) =>
        `<tr><td style="padding:4px 14px 4px 0;color:#6D7C7C;white-space:nowrap">${escapeHtml(label)}</td>` +
        `<td style="padding:4px 0"><b>${escapeHtml(lead[k])}</b></td></tr>`,
    )
    .join('');

  const signs = lead.signs.length
    ? `<p style="margin:16px 0 4px;color:#6D7C7C">Reported signs</p><ul style="margin:0;padding-left:20px">${lead.signs
        .map((s) => `<li>${escapeHtml(s)}</li>`)
        .join('')}</ul>`
    : '';

  const notes = lead.notes
    ? `<p style="margin:16px 0 4px;color:#6D7C7C">Notes</p><p style="margin:0;white-space:pre-wrap">${escapeHtml(lead.notes)}</p>`
    : '';

  const banner = priority
    ? '<p style="margin:0 0 16px;color:#8A2B1B;font-weight:700">PRIORITY — investigation clock running.</p>'
    : '';

  const footer = meta.receivedAt
    ? `<p style="margin:22px 0 0;font-size:12px;color:#9AA5A5">Received ${escapeHtml(meta.receivedAt)}${
        meta.requestId ? ` · req ${escapeHtml(meta.requestId)}` : ''
      }</p>`
    : '';

  return {
    from: { name: escapeHeader(config.fromName), address: config.fromEmail },
    to: config.toEmail,
    replyTo: { name: escapeHeader(lead.name) || lead.email, address: lead.email },
    subject,
    html:
      `<div style="font-family:Arial,sans-serif;font-size:15px;line-height:1.6;color:#08121F">` +
      banner +
      `<h2 style="margin:0 0 14px">New website enquiry</h2>` +
      `<table cellpadding="0" cellspacing="0" style="border-collapse:collapse;font-size:14px">` +
      `<tr><td style="padding:4px 14px 4px 0;color:#6D7C7C">Name</td><td style="padding:4px 0"><b>${escapeHtml(lead.name)}</b></td></tr>` +
      `<tr><td style="padding:4px 14px 4px 0;color:#6D7C7C">Email</td><td style="padding:4px 0"><a href="mailto:${escapeHtml(lead.email)}">${escapeHtml(lead.email)}</a></td></tr>` +
      rows +
      `</table>` +
      signs +
      notes +
      footer +
      `</div>`,
    text: buildNotificationText(lead, meta),
  };
}

function buildNotificationText(lead, meta) {
  const lines = [];
  if (isPriority(lead)) lines.push('*** PRIORITY — investigation clock running ***', '');
  lines.push(`Name: ${lead.name}`, `Email: ${lead.email}`);
  for (const [k, label] of FIELD_LABELS) if (lead[k]) lines.push(`${label}: ${lead[k]}`);
  if (lead.signs.length) lines.push('', 'Reported signs:', ...lead.signs.map((s) => `  - ${s}`));
  if (lead.notes) lines.push('', 'Notes:', lead.notes);
  if (meta.receivedAt) lines.push('', `Received ${meta.receivedAt}`);
  return lines.join('\n');
}

/** Build the nodemailer message for the acknowledgement sent to the enquirer. */
export function buildAckEmail(lead, config) {
  return {
    from: { name: escapeHeader(config.siteName), address: config.fromEmail },
    to: { name: escapeHeader(lead.name) || lead.email, address: lead.email },
    replyTo: { name: escapeHeader(config.siteName), address: config.toEmail },
    subject: escapeHeader(`We've got your survey request — ${config.siteName}`),
    html:
      `<div style="font-family:Arial,sans-serif;font-size:15px;line-height:1.6;color:#08121F">` +
      `<p>Thanks ${escapeHtml(firstName(lead.name))} — your survey request has reached us and a surveyor will come back to you within one working day.</p>` +
      `<p>If it's urgent, call <b>${escapeHtml(config.replyPhone)}</b> rather than waiting on email.</p>` +
      `<p style="margin-top:22px;font-size:13px;color:#6D7C7C">${escapeHtml(config.siteName)} — independent PCA-qualified damp and timber surveys.<br>` +
      `This is an automated acknowledgement; replies go to a monitored inbox.</p></div>`,
    text:
      `Thanks ${firstName(lead.name)} — your survey request has reached us and a surveyor will come back to you within one working day.\n\n` +
      `If it's urgent, call ${config.replyPhone} rather than waiting on email.\n\n` +
      `${config.siteName} — independent PCA-qualified damp and timber surveys.`,
  };
}

/* ------------------------------------------------------------------ *
 * Structured lead record (the durable fallback)
 * ------------------------------------------------------------------ */

/**
 * A single-line JSON record written to stderr for every accepted enquiry,
 * before any delivery is attempted. If the mail host is down, the mailbox
 * password is rotated badly, or SMTP starts refusing, the lead is still
 * recoverable from Vercel runtime logs by querying for LEAD_CAPTURE.
 */
export function leadRecord(lead, meta = {}) {
  return JSON.stringify({
    tag: 'LEAD_CAPTURE',
    receivedAt: meta.receivedAt ?? new Date().toISOString(),
    requestId: meta.requestId ?? null,
    priority: isPriority(lead),
    lead,
  });
}

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

function str(v) {
  return typeof v === 'string' ? v.trim() : '';
}

function trunc(v, max) {
  return v.length > max ? v.slice(0, max) : v;
}

function int(v, dflt, min, max) {
  const n = Number.parseInt(v ?? '', 10);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(max, Math.max(min, n));
}

function firstName(name) {
  return (name || '').split(/\s+/)[0] || 'there';
}

/**
 * Pragmatic address check. Deliberately not RFC 5322 — that grammar accepts
 * addresses no mail provider will route, and rejecting a real customer is a
 * worse failure than accepting an odd-looking address.
 */
export function isEmail(v) {
  if (typeof v !== 'string' || v.length > LIMITS.email) return false;
  if (/[\s<>,;\r\n]/.test(v)) return false;
  const at = v.indexOf('@');
  if (at < 1 || at !== v.lastIndexOf('@')) return false;
  const domain = v.slice(at + 1);
  if (domain.length < 3 || !domain.includes('.')) return false;
  if (domain.startsWith('.') || domain.endsWith('.') || domain.includes('..')) return false;
  if (domain.startsWith('-') || domain.endsWith('-')) return false;
  return /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+$/.test(v.slice(0, at));
}

/** Uppercase, collapse whitespace, and insert the single canonical space. */
export function normalisePostcode(v) {
  const compact = String(v ?? '')
    .toUpperCase()
    .replace(/[\s ]+/g, '');
  if (compact.length < 5 || compact.length > 8) return compact;
  return `${compact.slice(0, -3)} ${compact.slice(-3)}`;
}

const UK_POSTCODE = /^[A-Z]{1,2}\d[A-Z\d]?\s\d[A-Z]{2}$/;

export function isUkPostcode(v) {
  return UK_POSTCODE.test(String(v ?? '').toUpperCase());
}
