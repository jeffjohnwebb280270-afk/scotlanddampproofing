/**
 * POST /api/enquiry
 *
 * Receives the survey request form and delivers it by SMTP through the site's
 * own mailbox.
 *
 * Design rule: missing or broken mail config must never produce a 2xx. A
 * success response with nothing delivered loses the lead silently — no
 * bounce, no log line, no unhappy customer to tell you. This fails closed,
 * and writes every accepted lead to stderr as a structured LEAD_CAPTURE
 * record *before* attempting delivery, so a lead stays recoverable from
 * runtime logs even when every downstream hop is broken.
 *
 * The optional third argument exists for tests: Vercel only ever calls
 * handler(req, res), so injecting a transporter or an env object here costs
 * production nothing.
 */

import {
  resolveConfig,
  validateEnquiry,
  isBot,
  isPriority,
  leadRecord,
  buildNotificationEmail,
  buildAckEmail,
} from '../lib/enquiry-core.mjs';
import { sendEmail, SmtpError } from '../lib/smtp.mjs';

export default async function handler(req, res, deps = {}) {
  const env = deps.env ?? process.env;
  const transporter = deps.transporter;

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return json(res, 405, { error: 'Method not allowed' });
  }

  const requestId = req.headers?.['x-vercel-id'] ?? null;
  const receivedAt = new Date().toISOString();

  /* ---- 1. Config. Checked first so a misconfigured deploy fails before it
        can accept a lead it has no way to deliver. ------------------------ */
  const { ok: configOk, missing, warnings, config } = resolveConfig(env);

  for (const w of warnings) console.warn(`[enquiry] CONFIG_WARNING ${w}`);

  if (!configOk) {
    console.error(
      `[enquiry] CONFIG_ERROR missing=${missing.join(',')} — rejecting enquiry rather than silently dropping it`,
    );
    // Still capture the lead. A broken deploy is not the customer's problem.
    const salvage = validateEnquiry(readBody(req));
    if (salvage.ok) console.error(leadRecord(salvage.lead, { receivedAt, requestId }));
    return json(res, 503, {
      error: 'The enquiry service is temporarily unavailable. Please call or email us directly.',
    });
  }

  /* ---- 2. Parse and validate. ------------------------------------------ */
  const raw = readBody(req);
  if (raw === null) return json(res, 400, { error: 'Invalid JSON body.' });

  // Honeypot. Return the success shape so the bot learns nothing, but send
  // nothing and open no connection to the mail host.
  if (isBot(raw)) {
    console.warn(`[enquiry] SPAM_REJECTED honeypot filled req=${requestId}`);
    return json(res, 200, { ok: true });
  }

  const result = validateEnquiry(raw);
  if (!result.ok) {
    return json(res, 400, { error: result.errors.join('; '), fields: result.errors });
  }
  const { lead } = result;

  /* ---- 3. Durable capture, before any delivery attempt. ---------------- */
  console.error(leadRecord(lead, { receivedAt, requestId }));

  /* ---- 4. Deliver. ----------------------------------------------------- */
  try {
    const { messageId, attempts } = await sendEmail(
      buildNotificationEmail(lead, config, { receivedAt, requestId }),
      { config, transporter },
    );
    console.log(
      `[enquiry] SENT postcode=${lead.postcode} priority=${isPriority(lead)} attempts=${attempts} msg=${messageId}`,
    );
  } catch (err) {
    const e = err instanceof SmtpError ? err : new SmtpError(String(err?.message ?? err));
    console.error(
      `[enquiry] SEND_FAILED code=${e.code} responseCode=${e.responseCode} attempts=${e.attempts} msg="${e.message}" — lead is preserved in the LEAD_CAPTURE record above`,
    );
    return json(res, 502, {
      error: 'We could not send that just now. Please call or email us and we will pick it up directly.',
    });
  }

  /* ---- 5. Acknowledgement to the enquirer. Best-effort and single-attempt:
        a failure here must not fail the request, because the notification is
        already delivered. ------------------------------------------------- */
  if (config.sendAck) {
    try {
      await sendEmail(buildAckEmail(lead, config), {
        config: { ...config, maxAttempts: 1 },
        transporter,
      });
    } catch (err) {
      console.warn(`[enquiry] ACK_FAILED ${err?.message ?? err} — notification already delivered`);
    }
  }

  return json(res, 200, { ok: true });
}

/* ------------------------------------------------------------------ */

/** Vercel Node functions parse JSON bodies, but not always. Handle both. */
function readBody(req) {
  const b = req.body;
  if (b == null) return {};
  if (typeof b === 'object') return b;
  if (typeof b === 'string') {
    if (b.trim() === '') return {};
    try {
      return JSON.parse(b);
    } catch {
      return null;
    }
  }
  return null;
}

function json(res, status, payload) {
  res.status(status).setHeader('content-type', 'application/json; charset=utf-8');
  return res.send(JSON.stringify(payload));
}
