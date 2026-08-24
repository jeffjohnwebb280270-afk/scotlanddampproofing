/**
 * smtp.mjs — transport for the site's own mailbox (IONOS by default).
 *
 * Sends through the provider the domain's SPF already authorises, so there is
 * no third-party sender to add SPF/DKIM records for and no second supplier to
 * hold an account with.
 *
 * nodemailer is imported lazily, and a transporter can be injected, so the
 * test suite runs with no dependencies installed and never opens a socket.
 */

/** Connection/greeting/socket errors worth another attempt. */
const RETRYABLE_CODES = new Set([
  'ETIMEDOUT',
  'ETIMEOUT',
  'ECONNRESET',
  'ECONNECTION',
  'ESOCKET',
  'EDNS',
  'EPIPE',
]);

/** Errors that will fail identically on every retry. */
const FATAL_CODES = new Set(['EAUTH', 'EENVELOPE', 'EMESSAGE']);

export class SmtpError extends Error {
  constructor(message, { code = null, responseCode = null, attempts = 1, retryable = false, cause = null } = {}) {
    super(message);
    this.name = 'SmtpError';
    this.code = code;
    this.responseCode = responseCode;
    this.attempts = attempts;
    this.retryable = retryable;
    if (cause) this.cause = cause;
  }
}

export class SmtpTimeoutError extends Error {
  constructor(timeoutMs) {
    super(`SMTP send exceeded ${timeoutMs}ms`);
    this.name = 'SmtpTimeoutError';
    this.code = 'ETIMEDOUT';
  }
}

/**
 * Decide whether an error is worth another attempt.
 *
 * SMTP 4xx is a transient negative reply and retries; 5xx is permanent and
 * fails fast — retrying a 535 bad-password or a 550 rejected-recipient only
 * burns the request's time budget.
 */
export function isRetryable(err) {
  if (!err) return false;
  if (err.name === 'SmtpTimeoutError') return true;

  const rc = Number(err.responseCode);
  if (Number.isFinite(rc) && rc > 0) return rc >= 400 && rc < 500;

  if (FATAL_CODES.has(err.code)) return false;
  return RETRYABLE_CODES.has(err.code);
}

/** Exponential backoff with full jitter, in milliseconds. */
export function backoffMs(attempt, random = Math.random) {
  const base = Math.min(250 * 2 ** (attempt - 1), 4_000);
  return Math.round(base * (0.5 + random() * 0.5));
}

/** Build a real nodemailer transporter. Imported lazily — see file header. */
export async function createTransport(config) {
  const { default: nodemailer } = await import('nodemailer');
  return nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure: config.secure, // 465 = implicit TLS, 587 = STARTTLS
    auth: { user: config.user, pass: config.pass },
    connectionTimeout: config.timeoutMs,
    greetingTimeout: config.timeoutMs,
    socketTimeout: config.timeoutMs,
  });
}

// The timer is deliberately NOT unref'd: an unref'd timeout cannot fire once
// it is the only thing left holding the event loop open, which is exactly the
// case where a hung transport most needs cutting off. clearTimeout in the
// finally keeps it from outliving the race.
function withTimeout(promise, timeoutMs) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new SmtpTimeoutError(timeoutMs)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Send one message, with a per-attempt timeout and jittered retry.
 *
 * @param {object} message   nodemailer message object
 * @param {object} opts      { config, transporter?, sleep?, random? }
 * @returns {Promise<{ok:true, attempts:number, messageId:string|null, response:string|null}>}
 */
export async function sendEmail(message, opts = {}) {
  const { config, transporter, sleep = defaultSleep, random = Math.random } = opts;
  if (!config) throw new TypeError('sendEmail requires opts.config');

  const maxAttempts = Math.max(1, config.maxAttempts ?? 1);
  const timeoutMs = config.timeoutMs ?? 10_000;
  const tx = transporter ?? (await createTransport(config));

  let lastErr = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const info = await withTimeout(Promise.resolve(tx.sendMail(message)), timeoutMs);
      return {
        ok: true,
        attempts: attempt,
        messageId: info?.messageId ?? null,
        response: info?.response ?? null,
      };
    } catch (err) {
      lastErr = err;
      if (!isRetryable(err) || attempt === maxAttempts) break;
      await sleep(backoffMs(attempt, random));
    }
  }

  throw new SmtpError(lastErr?.message || 'SMTP send failed', {
    code: lastErr?.code ?? null,
    responseCode: Number.isFinite(Number(lastErr?.responseCode)) ? Number(lastErr.responseCode) : null,
    attempts: Math.min(maxAttempts, countedAttempts(lastErr, maxAttempts)),
    retryable: isRetryable(lastErr),
    cause: lastErr,
  });
}

function countedAttempts(err, maxAttempts) {
  return isRetryable(err) ? maxAttempts : 1;
}

/**
 * Probe the mail host without sending anything — used by /api/health behind a
 * token. Resolves { ok:true } or { ok:false, code, message }.
 */
export async function verifyTransport(config, opts = {}) {
  const tx = opts.transporter ?? (await createTransport(config));
  try {
    await withTimeout(Promise.resolve(tx.verify()), config.timeoutMs ?? 10_000);
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      code: err?.code ?? null,
      responseCode: Number.isFinite(Number(err?.responseCode)) ? Number(err.responseCode) : null,
      message: err?.message || 'verify failed',
    };
  }
}
