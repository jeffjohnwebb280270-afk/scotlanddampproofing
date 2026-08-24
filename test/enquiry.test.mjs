import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  resolveConfig,
  validateEnquiry,
  isBot,
  isPriority,
  escapeHtml,
  escapeHeader,
  buildNotificationEmail,
  buildAckEmail,
  leadRecord,
  normalisePostcode,
  isUkPostcode,
  isEmail,
  LIMITS,
} from '../lib/enquiry-core.mjs';
import { sendEmail, SmtpError, isRetryable, backoffMs } from '../lib/smtp.mjs';
import handler from '../api/enquiry.mjs';
import health from '../api/health.mjs';

const USER = 'contact@scotlanddampproofing.co.uk';
const GOOD_ENV = Object.freeze({ SMTP_USER: USER, SMTP_PASS: 'mailbox-password' });

const VALID = Object.freeze({
  who: 'Landlord',
  type: 'Tenement flat',
  age: 'Pre-1919',
  signs: ['tide', 'plaster'],
  urgency: 'Within a month',
  postcode: 'g417ry',
  name: 'Ada Lovelace',
  email: 'Ada@Example.COM',
  phone: '07700 900123',
  notes: 'Tide mark on the gable wall.',
  hp: '',
});

const CONFIG = resolveConfig(GOOD_ENV).config;

/* ================================================================== *
 * resolveConfig
 * ================================================================== */

describe('resolveConfig', () => {
  test('reports both credentials missing on an empty environment', () => {
    const r = resolveConfig({});
    assert.equal(r.ok, false);
    assert.deepEqual(r.missing, ['SMTP_USER', 'SMTP_PASS']);
  });

  test('is ok with just user and password', () => {
    assert.equal(resolveConfig(GOOD_ENV).ok, true);
  });

  test('defaults to IONOS on 587 STARTTLS', () => {
    const c = resolveConfig(GOOD_ENV).config;
    assert.equal(c.host, 'smtp.ionos.co.uk');
    assert.equal(c.port, 587);
    assert.equal(c.secure, false);
  });

  test('port 465 selects implicit TLS', () => {
    assert.equal(resolveConfig({ ...GOOD_ENV, SMTP_PORT: '465' }).config.secure, true);
  });

  test('warns on a port that is neither 587 nor 465', () => {
    const r = resolveConfig({ ...GOOD_ENV, SMTP_PORT: '2525' });
    assert.match(r.warnings.join(' '), /2525/);
    assert.equal(r.ok, true, 'an odd port is a warning, not a failure');
  });

  test('warns when a Brevo key is left in SMTP_PASS', () => {
    const r = resolveConfig({ ...GOOD_ENV, SMTP_PASS: 'xkeysib-' + 'a'.repeat(20) });
    assert.match(r.warnings.join(' '), /Brevo API key/);
  });

  test('never echoes the password into missing or warnings', () => {
    const secret = 'xsmtpsib-SUPERSECRETVALUE';
    const r = resolveConfig({ ...GOOD_ENV, SMTP_PASS: secret });
    const text = [...r.missing, ...r.warnings].join(' ');
    assert.equal(text.includes(secret), false);
  });

  test('rejects an SMTP_USER that is not an address', () => {
    const r = resolveConfig({ SMTP_USER: 'not-an-address', SMTP_PASS: 'x' });
    assert.equal(r.ok, false);
    assert.match(r.missing.join(' '), /SMTP_USER/);
  });

  test('From is forced to the authenticated mailbox', () => {
    const c = resolveConfig(GOOD_ENV).config;
    assert.equal(c.fromEmail, USER);
  });

  test('a differing ENQUIRY_FROM_EMAIL is ignored, loudly', () => {
    const r = resolveConfig({ ...GOOD_ENV, ENQUIRY_FROM_EMAIL: 'noreply@elsewhere.co.uk' });
    assert.equal(r.config.fromEmail, USER, 'providers reject an unauthenticated sender');
    assert.match(r.warnings.join(' '), /ignored/);
  });

  test('SMTP_TO defaults to the sending mailbox', () => {
    assert.equal(resolveConfig(GOOD_ENV).config.toEmail, USER);
  });

  test('SMTP_TO overrides the destination', () => {
    const c = resolveConfig({ ...GOOD_ENV, SMTP_TO: 'leads@scotlanddampproofing.co.uk' }).config;
    assert.equal(c.toEmail, 'leads@scotlanddampproofing.co.uk');
  });

  test('a malformed SMTP_TO is a hard failure', () => {
    const r = resolveConfig({ ...GOOD_ENV, SMTP_TO: 'nope' });
    assert.equal(r.ok, false);
  });

  test('timeout and attempts are clamped to sane bounds', () => {
    assert.equal(resolveConfig({ ...GOOD_ENV, ENQUIRY_TIMEOUT_MS: '1' }).config.timeoutMs, 1_000);
    assert.equal(resolveConfig({ ...GOOD_ENV, ENQUIRY_TIMEOUT_MS: '999999' }).config.timeoutMs, 30_000);
    assert.equal(resolveConfig({ ...GOOD_ENV, ENQUIRY_MAX_ATTEMPTS: '99' }).config.maxAttempts, 5);
    assert.equal(resolveConfig({ ...GOOD_ENV, ENQUIRY_MAX_ATTEMPTS: 'abc' }).config.maxAttempts, 3);
  });

  test('the acknowledgement is off unless explicitly enabled', () => {
    assert.equal(resolveConfig(GOOD_ENV).config.sendAck, false);
    assert.equal(resolveConfig({ ...GOOD_ENV, ENQUIRY_SEND_ACK: '1' }).config.sendAck, true);
  });
});

/* ================================================================== *
 * validateEnquiry
 * ================================================================== */

describe('validateEnquiry', () => {
  test('accepts the reference payload', () => {
    assert.equal(validateEnquiry(VALID).ok, true);
  });

  test('lowercases the email and canonicalises the postcode', () => {
    const { lead } = validateEnquiry(VALID);
    assert.equal(lead.email, 'ada@example.com');
    assert.equal(lead.postcode, 'G41 7RY');
  });

  test('requires name, email and postcode', () => {
    const r = validateEnquiry({});
    assert.equal(r.ok, false);
    assert.deepEqual(r.errors.slice(0, 3), ['name is required', 'email is required', 'postcode is required']);
  });

  test('rejects a non-object body', () => {
    for (const bad of [null, 'string', 42, []]) assert.equal(validateEnquiry(bad).ok, false);
  });

  test('rejects a malformed email', () => {
    const r = validateEnquiry({ ...VALID, email: 'ada@@example.com' });
    assert.match(r.errors.join(' '), /email is not a valid address/);
  });

  test('an odd postcode is ACCEPTED and flagged, never rejected', () => {
    const r = validateEnquiry({ ...VALID, postcode: '90210' });
    assert.equal(r.ok, true, 'a mistyped postcode must not cost a lead');
    assert.equal(r.lead.postcodeLooksOdd, true);
  });

  test('a normal Scottish postcode is not flagged', () => {
    for (const pc of ['G41 7RY', 'EH1 1YZ', 'AB10 1XG', 'IV1 1AA', 'KW1 4YT']) {
      assert.equal(validateEnquiry({ ...VALID, postcode: pc }).lead.postcodeLooksOdd, false, pc);
    }
  });

  test('an odd postcode is flagged in the notification, both parts', () => {
    const odd = validateEnquiry({ ...VALID, postcode: '90210' }).lead;
    const m = buildNotificationEmail(odd, CONFIG);
    assert.match(m.html, /not a standard UK format/);
    assert.match(m.text, /not a standard UK format/);
  });

  test('truncates an overlong name rather than rejecting it', () => {
    const { lead } = validateEnquiry({ ...VALID, name: 'x'.repeat(500) });
    assert.equal(lead.name.length, LIMITS.name);
  });

  test('truncates overlong notes', () => {
    const { lead } = validateEnquiry({ ...VALID, notes: 'y'.repeat(9999) });
    assert.equal(lead.notes.length, LIMITS.notes);
  });

  test('caps the number of signs', () => {
    const { lead } = validateEnquiry({ ...VALID, signs: Array(99).fill('tide') });
    assert.equal(lead.signs.length, LIMITS.signsCount);
  });

  test('drops non-string entries from signs', () => {
    const { lead } = validateEnquiry({ ...VALID, signs: ['tide', 7, null, 'rot'] });
    assert.deepEqual(lead.signs, ['tide', 'rot']);
  });

  test('signs may be absent', () => {
    const { signs, ...noSigns } = VALID;
    const r = validateEnquiry(noSigns);
    assert.equal(r.ok, true);
    assert.deepEqual(r.lead.signs, []);
  });

  test('a non-array signs value is an error', () => {
    assert.equal(validateEnquiry({ ...VALID, signs: 'tide' }).ok, false);
  });

  test('an unknown sign is accepted — the form owns that vocabulary', () => {
    const { lead } = validateEnquiry({ ...VALID, signs: ['something-new'] });
    assert.deepEqual(lead.signs, ['something-new']);
  });
});

/* ================================================================== *
 * isBot / isPriority
 * ================================================================== */

describe('isBot / isPriority', () => {
  test('an empty honeypot is a human', () => {
    assert.equal(isBot(VALID), false);
  });

  test('a filled honeypot is a bot', () => {
    assert.equal(isBot({ ...VALID, hp: 'buy cheap' }), true);
  });

  test('whitespace in the honeypot is still a human', () => {
    assert.equal(isBot({ ...VALID, hp: '   ' }), false);
  });

  test('a running investigation clock is priority', () => {
    assert.equal(isPriority({ urgency: 'Investigation clock running', signs: [] }), true);
  });

  test('the clock match is case-insensitive', () => {
    assert.equal(isPriority({ urgency: 'INVESTIGATION CLOCK RUNNING', signs: [] }), true);
  });

  test('suspected dry rot is priority regardless of urgency', () => {
    assert.equal(isPriority({ urgency: 'No rush', signs: ['fungus'] }), true);
  });

  test('an ordinary enquiry is not priority', () => {
    assert.equal(isPriority({ urgency: 'Within a month', signs: ['tide'] }), false);
  });
});

/* ================================================================== *
 * Escaping
 * ================================================================== */

describe('escaping', () => {
  test('escapes the five HTML metacharacters', () => {
    assert.equal(escapeHtml(`<&">'`), '&lt;&amp;&quot;&gt;&#39;'.replace('&gt;&#39;', '&gt;&#39;'));
  });

  test('neutralises a script tag in a name', () => {
    const out = escapeHtml('<script>alert(1)</script>');
    assert.equal(out.includes('<script>'), false);
    assert.match(out, /&lt;script&gt;/);
  });

  test('escapes an attribute-breaking quote', () => {
    assert.match(escapeHtml('" onload="x'), /&quot;/);
  });

  test('handles null and undefined', () => {
    assert.equal(escapeHtml(null), '');
    assert.equal(escapeHtml(undefined), '');
  });

  test('strips CR and LF from a header value', () => {
    assert.equal(escapeHeader('Ada\r\nBcc: victim@example.com'), 'Ada Bcc: victim@example.com');
  });

  test('a bare newline cannot survive into a header', () => {
    assert.equal(escapeHeader('a\nb').includes('\n'), false);
  });

  test('trims the result', () => {
    assert.equal(escapeHeader('  spaced  '), 'spaced');
  });
});

/* ================================================================== *
 * buildNotificationEmail
 * ================================================================== */

describe('buildNotificationEmail', () => {
  const lead = validateEnquiry(VALID).lead;

  test('sends from the authenticated mailbox', () => {
    const m = buildNotificationEmail(lead, CONFIG);
    assert.equal(m.from.address, USER);
  });

  test('puts the enquirer in Reply-To so replying answers the customer', () => {
    const m = buildNotificationEmail(lead, CONFIG);
    assert.equal(m.replyTo.address, 'ada@example.com');
  });

  test('addresses the configured destination', () => {
    const m = buildNotificationEmail(lead, CONFIG);
    assert.equal(m.to, CONFIG.toEmail);
  });

  test('names the enquirer in the subject', () => {
    assert.match(buildNotificationEmail(lead, CONFIG).subject, /Ada Lovelace/);
  });

  test('prefixes PRIORITY when the clock is running', () => {
    const p = validateEnquiry({ ...VALID, urgency: 'Investigation clock running' }).lead;
    assert.match(buildNotificationEmail(p, CONFIG).subject, /^PRIORITY —/);
  });

  test('an ordinary enquiry gets no PRIORITY prefix', () => {
    assert.equal(buildNotificationEmail(lead, CONFIG).subject.startsWith('PRIORITY'), false);
  });

  test('a CRLF in the name cannot inject a header', () => {
    const evil = validateEnquiry({ ...VALID, name: 'Ada\r\nBcc: victim@example.com' }).lead;
    const m = buildNotificationEmail(evil, CONFIG);
    assert.equal(m.subject.includes('\n'), false);
    assert.equal(m.subject.includes('\r'), false);
    assert.equal(String(m.replyTo.name).includes('\n'), false);
  });

  test('HTML in a field is escaped in the body', () => {
    const evil = validateEnquiry({ ...VALID, notes: '<img src=x onerror=alert(1)>' }).lead;
    const m = buildNotificationEmail(evil, CONFIG);
    assert.equal(m.html.includes('<img src=x'), false);
    assert.match(m.html, /&lt;img/);
  });

  test('carries both an HTML and a plain-text alternative', () => {
    const m = buildNotificationEmail(lead, CONFIG);
    assert.ok(m.html.length > 0);
    assert.ok(m.text.length > 0);
  });

  test('the text part lists the reported signs', () => {
    assert.match(buildNotificationEmail(lead, CONFIG).text, /tide/);
  });

  test('omits fields the enquirer left blank', () => {
    const sparse = validateEnquiry({ name: 'A B', email: 'a@b.co.uk', postcode: 'G1 1AA' }).lead;
    const m = buildNotificationEmail(sparse, CONFIG);
    assert.equal(m.html.includes('Building age'), false);
  });

  test('includes the received timestamp when given one', () => {
    const m = buildNotificationEmail(lead, CONFIG, { receivedAt: '2026-08-24T10:00:00.000Z' });
    assert.match(m.html, /2026-08-24/);
  });
});

/* ================================================================== *
 * buildAckEmail
 * ================================================================== */

describe('buildAckEmail', () => {
  const lead = validateEnquiry(VALID).lead;

  test('is addressed to the enquirer', () => {
    assert.equal(buildAckEmail(lead, CONFIG).to.address, 'ada@example.com');
  });

  test('also sends from the authenticated mailbox', () => {
    assert.equal(buildAckEmail(lead, CONFIG).from.address, USER);
  });

  test('replies route back to the monitored inbox', () => {
    assert.equal(buildAckEmail(lead, CONFIG).replyTo.address, CONFIG.toEmail);
  });

  test('greets by first name', () => {
    assert.match(buildAckEmail(lead, CONFIG).text, /Thanks Ada/);
  });

  test('carries the phone number for urgent cases', () => {
    assert.match(buildAckEmail(lead, CONFIG).text, /07446 522034/);
  });
});

/* ================================================================== *
 * leadRecord
 * ================================================================== */

describe('leadRecord', () => {
  const lead = validateEnquiry(VALID).lead;

  test('is a single line of JSON', () => {
    const r = leadRecord(lead);
    assert.equal(r.includes('\n'), false);
    assert.doesNotThrow(() => JSON.parse(r));
  });

  test('is tagged LEAD_CAPTURE so it can be grepped out of the logs', () => {
    assert.equal(JSON.parse(leadRecord(lead)).tag, 'LEAD_CAPTURE');
  });

  test('carries every field needed to answer the customer', () => {
    const { lead: l } = JSON.parse(leadRecord(lead));
    assert.equal(l.email, 'ada@example.com');
    assert.equal(l.phone, '07700 900123');
    assert.equal(l.postcode, 'G41 7RY');
  });

  test('records the priority flag', () => {
    const p = validateEnquiry({ ...VALID, urgency: 'Investigation clock running' }).lead;
    assert.equal(JSON.parse(leadRecord(p)).priority, true);
  });

  test('stamps the request id when supplied', () => {
    assert.equal(JSON.parse(leadRecord(lead, { requestId: 'req-1' })).requestId, 'req-1');
  });
});

/* ================================================================== *
 * sendEmail (SMTP)
 * ================================================================== */

describe('sendEmail', () => {
  test('classifies SMTP 4xx as retryable and 5xx as fatal', () => {
    assert.equal(isRetryable({ responseCode: 421 }), true);
    assert.equal(isRetryable({ responseCode: 450 }), true);
    assert.equal(isRetryable({ responseCode: 535 }), false);
    assert.equal(isRetryable({ responseCode: 550 }), false);
  });

  test('classifies connection errors as retryable and auth errors as fatal', () => {
    assert.equal(isRetryable({ code: 'ECONNRESET' }), true);
    assert.equal(isRetryable({ code: 'ETIMEDOUT' }), true);
    assert.equal(isRetryable({ code: 'EAUTH' }), false);
    assert.equal(isRetryable({ code: 'EENVELOPE' }), false);
  });

  test('backoff grows and stays jittered within bounds', () => {
    assert.equal(backoffMs(1, () => 0), 125);
    assert.equal(backoffMs(1, () => 1), 250);
    assert.ok(backoffMs(3, () => 1) > backoffMs(1, () => 1));
    assert.ok(backoffMs(9, () => 1) <= 4_000, 'capped');
  });

  test('returns the messageId on success', async () => {
    const r = await sendEmail({ subject: 'x' }, {
      config: CONFIG,
      transporter: fakeTransport([{ messageId: '<m1>', response: '250 OK' }]),
      sleep: noSleep,
    });
    assert.equal(r.messageId, '<m1>');
    assert.equal(r.attempts, 1);
    assert.equal(r.ok, true);
  });

  test('hands the message straight to the transport', async () => {
    const tx = fakeTransport([{ messageId: '<m>' }]);
    await sendEmail({ subject: 'hello' }, { config: CONFIG, transporter: tx, sleep: noSleep });
    assert.equal(tx.sent.length, 1);
    assert.equal(tx.sent[0].subject, 'hello');
  });

  test('retries a transient 4xx and succeeds', async () => {
    const tx = fakeTransport([smtpErr(421, 'try later'), { messageId: '<m2>' }]);
    const r = await sendEmail({}, { config: CONFIG, transporter: tx, sleep: noSleep });
    assert.equal(r.attempts, 2);
    assert.equal(tx.calls, 2);
  });

  test('does NOT retry a 535 — a bad password will still be bad in 250ms', async () => {
    const tx = fakeTransport([smtpErr(535, 'auth failed'), { messageId: '<never>' }]);
    await assert.rejects(
      () => sendEmail({}, { config: CONFIG, transporter: tx, sleep: noSleep }),
      (e) => e instanceof SmtpError && e.responseCode === 535 && e.retryable === false,
    );
    assert.equal(tx.calls, 1);
  });

  test('does not retry a rejected recipient', async () => {
    const tx = fakeTransport([smtpErr(550, 'no such user')]);
    await assert.rejects(() => sendEmail({}, { config: CONFIG, transporter: tx, sleep: noSleep }));
    assert.equal(tx.calls, 1);
  });

  test('gives up after maxAttempts and throws SmtpError', async () => {
    const tx = fakeTransport([smtpErr(421), smtpErr(421), smtpErr(421), smtpErr(421)]);
    await assert.rejects(
      () => sendEmail({}, { config: { ...CONFIG, maxAttempts: 3 }, transporter: tx, sleep: noSleep }),
      (e) => e instanceof SmtpError && e.attempts === 3,
    );
    assert.equal(tx.calls, 3);
  });

  test('honours maxAttempts of 1 — no retry at all', async () => {
    const tx = fakeTransport([smtpErr(421), { messageId: '<never>' }]);
    await assert.rejects(() =>
      sendEmail({}, { config: { ...CONFIG, maxAttempts: 1 }, transporter: tx, sleep: noSleep }),
    );
    assert.equal(tx.calls, 1);
  });

  test('a hung transport is cut off by the timeout', async () => {
    const tx = { sendMail: () => new Promise(() => {}) };
    await assert.rejects(
      () => sendEmail({}, { config: { ...CONFIG, timeoutMs: 20, maxAttempts: 1 }, transporter: tx, sleep: noSleep }),
      (e) => e instanceof SmtpError && e.code === 'ETIMEDOUT',
    );
  });

  test('a timeout is retried', async () => {
    let calls = 0;
    const tx = {
      sendMail: () => {
        calls += 1;
        return calls === 1 ? new Promise(() => {}) : Promise.resolve({ messageId: '<ok>' });
      },
    };
    const r = await sendEmail({}, {
      config: { ...CONFIG, timeoutMs: 20, maxAttempts: 2 },
      transporter: tx,
      sleep: noSleep,
    });
    assert.equal(r.attempts, 2);
  });

  test('requires a config', async () => {
    await assert.rejects(() => sendEmail({}, {}), TypeError);
  });

  test('the thrown error never carries the password', async () => {
    const tx = fakeTransport([smtpErr(535, 'auth failed')]);
    const err = await sendEmail({}, { config: CONFIG, transporter: tx, sleep: noSleep }).catch((e) => e);
    assert.equal(JSON.stringify({ m: err.message, c: err.code }).includes(CONFIG.pass), false);
  });
});

/* ================================================================== *
 * POST /api/enquiry
 * ================================================================== */

describe('POST /api/enquiry', () => {
  let logs;

  beforeEach(() => {
    logs = [];
    for (const level of ['log', 'warn', 'error']) {
      const orig = console[level];
      console[level] = (...a) => { logs.push({ level, msg: a.join(' ') }); };
      console[level]._orig = orig;
    }
  });

  afterEach(() => {
    for (const level of ['log', 'warn', 'error']) console[level] = console[level]._orig;
  });

  const captured = () => logs.filter((l) => l.msg.includes('"tag":"LEAD_CAPTURE"'));

  test('rejects a GET with 405 and an Allow header', async () => {
    const res = mockRes();
    await handler(mockReq(null, { method: 'GET' }), res, { env: GOOD_ENV });
    assert.equal(res.statusCode, 405);
    assert.equal(res.headers.allow, 'POST');
  });

  test('THE DESIGN RULE: with no mail config it returns 503, not a fake success', async () => {
    const res = mockRes();
    await handler(mockReq(VALID), res, { env: {} });
    assert.equal(res.statusCode, 503);
    assert.notEqual(parse(res).ok, true);
  });

  test('a config failure still preserves the lead in the logs', async () => {
    await handler(mockReq(VALID), mockRes(), { env: {} });
    assert.equal(captured().length, 1);
    assert.match(captured()[0].msg, /ada@example\.com/);
  });

  test('a config failure logs a CONFIG_ERROR naming the missing variable', async () => {
    await handler(mockReq(VALID), mockRes(), { env: {} });
    const err = logs.find((l) => l.msg.includes('CONFIG_ERROR'));
    assert.ok(err, 'expected a CONFIG_ERROR line');
    assert.match(err.msg, /SMTP_USER/);
  });

  test('the 503 body never leaks internal configuration detail', async () => {
    const res = mockRes();
    await handler(mockReq(VALID), res, { env: {} });
    assert.equal(res.body.includes('SMTP'), false);
  });

  test('happy path returns 200 and sends exactly once', async () => {
    const tx = fakeTransport([{ messageId: '<m>' }]);
    const res = mockRes();
    await handler(mockReq(VALID), res, { env: GOOD_ENV, transporter: tx });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(parse(res), { ok: true });
    assert.equal(tx.calls, 1);
  });

  test('the lead is captured before the send is attempted', async () => {
    const order = [];
    const tx = { sendMail: async () => { order.push('send'); return { messageId: '<m>' }; } };
    for (const level of ['error']) {
      const orig = console[level];
      console[level] = (...a) => { if (String(a[0]).includes('LEAD_CAPTURE')) order.push('capture'); orig.call(console, ...a); };
    }
    await handler(mockReq(VALID), mockRes(), { env: GOOD_ENV, transporter: tx });
    assert.deepEqual(order, ['capture', 'send']);
  });

  test('a filled honeypot gets a fake 200 and opens no connection', async () => {
    const tx = fakeTransport([{ messageId: '<never>' }]);
    const res = mockRes();
    await handler(mockReq({ ...VALID, hp: 'spam' }), res, { env: GOOD_ENV, transporter: tx });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(parse(res), { ok: true });
    assert.equal(tx.calls, 0, 'no mail for a bot');
  });

  test('a bot lead is not written to LEAD_CAPTURE', async () => {
    await handler(mockReq({ ...VALID, hp: 'spam' }), mockRes(), { env: GOOD_ENV, transporter: fakeTransport([]) });
    assert.equal(captured().length, 0);
  });

  test('an invalid payload is a 400 that names the fields', async () => {
    const res = mockRes();
    await handler(mockReq({ name: 'x' }), res, { env: GOOD_ENV, transporter: fakeTransport([]) });
    assert.equal(res.statusCode, 400);
    assert.match(parse(res).error, /email is required/);
  });

  test('a 400 never reaches the mail host', async () => {
    const tx = fakeTransport([{ messageId: '<never>' }]);
    await handler(mockReq({ name: 'x' }), mockRes(), { env: GOOD_ENV, transporter: tx });
    assert.equal(tx.calls, 0);
  });

  test('unparseable JSON is a 400, not a 500', async () => {
    const res = mockRes();
    await handler(mockReq('{not json'), res, { env: GOOD_ENV, transporter: fakeTransport([]) });
    assert.equal(res.statusCode, 400);
  });

  test('a string body of valid JSON is accepted', async () => {
    const res = mockRes();
    await handler(mockReq(JSON.stringify(VALID)), res, { env: GOOD_ENV, transporter: fakeTransport([{ messageId: '<m>' }]) });
    assert.equal(res.statusCode, 200);
  });

  test('a send failure is a 502, never a 200', async () => {
    const res = mockRes();
    await handler(mockReq(VALID), res, {
      env: GOOD_ENV,
      transporter: fakeTransport([smtpErr(535, 'auth failed')]),
    });
    assert.equal(res.statusCode, 502);
    assert.notEqual(parse(res).ok, true);
  });

  test('a send failure still leaves the lead in the logs', async () => {
    await handler(mockReq(VALID), mockRes(), {
      env: GOOD_ENV,
      transporter: fakeTransport([smtpErr(550, 'rejected')]),
    });
    assert.equal(captured().length, 1);
    assert.match(logs.find((l) => l.msg.includes('SEND_FAILED')).msg, /LEAD_CAPTURE/);
  });

  test('the 502 body tells the customer what to do instead', async () => {
    const res = mockRes();
    await handler(mockReq(VALID), res, { env: GOOD_ENV, transporter: fakeTransport([smtpErr(550)]) });
    assert.match(parse(res).error, /call or email us/);
  });

  test('config warnings are logged but do not block delivery', async () => {
    const res = mockRes();
    await handler(mockReq(VALID), res, {
      env: { ...GOOD_ENV, SMTP_PORT: '2525' },
      transporter: fakeTransport([{ messageId: '<m>' }]),
    });
    assert.equal(res.statusCode, 200);
    assert.ok(logs.some((l) => l.msg.includes('CONFIG_WARNING')));
  });

  test('no acknowledgement is sent unless enabled', async () => {
    const tx = fakeTransport([{ messageId: '<m>' }, { messageId: '<ack>' }]);
    await handler(mockReq(VALID), mockRes(), { env: GOOD_ENV, transporter: tx });
    assert.equal(tx.calls, 1);
  });

  test('the acknowledgement is sent when enabled', async () => {
    const tx = fakeTransport([{ messageId: '<m>' }, { messageId: '<ack>' }]);
    await handler(mockReq(VALID), mockRes(), {
      env: { ...GOOD_ENV, ENQUIRY_SEND_ACK: '1' },
      transporter: tx,
    });
    assert.equal(tx.calls, 2);
    assert.equal(tx.sent[1].to.address, 'ada@example.com');
  });

  test('a failed acknowledgement does not fail the request', async () => {
    const tx = fakeTransport([{ messageId: '<m>' }, smtpErr(550, 'ack bounced')]);
    const res = mockRes();
    await handler(mockReq(VALID), res, {
      env: { ...GOOD_ENV, ENQUIRY_SEND_ACK: '1' },
      transporter: tx,
    });
    assert.equal(res.statusCode, 200, 'the notification was already delivered');
    assert.ok(logs.some((l) => l.msg.includes('ACK_FAILED')));
  });

  test('the SENT line records priority and attempt count', async () => {
    await handler(mockReq({ ...VALID, urgency: 'Investigation clock running' }), mockRes(), {
      env: GOOD_ENV,
      transporter: fakeTransport([{ messageId: '<m>' }]),
    });
    const sent = logs.find((l) => l.msg.includes('SENT'));
    assert.match(sent.msg, /priority=true/);
    assert.match(sent.msg, /attempts=1/);
  });

  test('an odd postcode is accepted, logged, and still delivered', async () => {
    const res = mockRes();
    await handler(mockReq({ ...VALID, postcode: '90210' }), res, {
      env: GOOD_ENV, transporter: fakeTransport([{ messageId: '<m>' }]),
    });
    assert.equal(res.statusCode, 200, 'a mistyped postcode must not cost a lead');
    assert.ok(logs.some((l) => l.msg.includes('POSTCODE_ODD')));
  });

  test('the response is JSON', async () => {
    const res = mockRes();
    await handler(mockReq(VALID), res, { env: GOOD_ENV, transporter: fakeTransport([{ messageId: '<m>' }]) });
    assert.match(res.headers['content-type'], /application\/json/);
  });
});

/* ================================================================== *
 * GET /api/health
 * ================================================================== */

describe('GET /api/health', () => {
  test('reports ok with a complete configuration', async () => {
    const res = mockRes();
    await health(mockReq(null, { method: 'GET' }), res, { env: GOOD_ENV });
    assert.equal(res.statusCode, 200);
    assert.equal(parse(res).status, 'ok');
  });

  test('reports 503 and names what is missing', async () => {
    const res = mockRes();
    await health(mockReq(null, { method: 'GET' }), res, { env: {} });
    assert.equal(res.statusCode, 503);
    assert.equal(parse(res).status, 'misconfigured');
    assert.deepEqual(parse(res).missing, ['SMTP_USER', 'SMTP_PASS']);
  });

  test('never returns the password or any part of it', async () => {
    const res = mockRes();
    await health(mockReq(null, { method: 'GET' }), res, { env: GOOD_ENV });
    assert.equal(res.body.includes('mailbox-password'), false);
    assert.equal(parse(res).config.passPresent, true);
  });

  test('reports the host and port actually in use', async () => {
    const res = mockRes();
    await health(mockReq(null, { method: 'GET' }), res, { env: { ...GOOD_ENV, SMTP_PORT: '465' } });
    const c = parse(res).config;
    assert.equal(c.host, 'smtp.ionos.co.uk');
    assert.equal(c.port, 465);
    assert.equal(c.secure, true);
  });

  test('refuses the live probe without a matching token', async () => {
    const res = mockRes();
    await health(mockReq(null, { method: 'GET', query: { probe: '1' } }), res, { env: GOOD_ENV });
    assert.equal(parse(res).probe.run, false);
  });

  test('runs the probe with a matching token', async () => {
    const res = mockRes();
    await health(
      mockReq(null, { method: 'GET', query: { probe: '1' }, headers: { 'x-health-token': 'secret' } }),
      res,
      { env: { ...GOOD_ENV, ENQUIRY_HEALTH_TOKEN: 'secret' }, transporter: { verify: async () => true } },
    );
    assert.equal(parse(res).probe.ok, true);
  });

  test('a failing probe degrades the status to 503', async () => {
    const res = mockRes();
    await health(
      mockReq(null, { method: 'GET', query: { probe: '1' }, headers: { 'x-health-token': 'secret' } }),
      res,
      {
        env: { ...GOOD_ENV, ENQUIRY_HEALTH_TOKEN: 'secret' },
        transporter: { verify: async () => { throw smtpErr(535, 'bad auth'); } },
      },
    );
    assert.equal(res.statusCode, 503);
    assert.equal(parse(res).status, 'degraded');
    assert.match(parse(res).probe.hint, /credentials/);
  });

  test('rejects a POST', async () => {
    const res = mockRes();
    await health(mockReq(null, { method: 'POST' }), res, { env: GOOD_ENV });
    assert.equal(res.statusCode, 405);
  });

  test('is never cached', async () => {
    const res = mockRes();
    await health(mockReq(null, { method: 'GET' }), res, { env: GOOD_ENV });
    assert.equal(res.headers['cache-control'], 'no-store');
  });
});

/* ================================================================== *
 * Helpers
 * ================================================================== */

const noSleep = () => Promise.resolve();

/** An SMTP error shaped the way nodemailer surfaces one. */
function smtpErr(responseCode, message = 'smtp error') {
  const e = new Error(message);
  e.responseCode = responseCode;
  e.code = responseCode === 535 ? 'EAUTH' : 'EMESSAGE';
  if (responseCode >= 400 && responseCode < 500) e.code = 'ECONNECTION';
  return e;
}

/**
 * A transporter that replays a scripted sequence: an Error entry is thrown,
 * anything else is resolved as nodemailer's info object.
 */
function fakeTransport(script) {
  const tx = {
    calls: 0,
    sent: [],
    async sendMail(message) {
      const step = script[tx.calls];
      tx.calls += 1;
      tx.sent.push(message);
      if (step instanceof Error) throw step;
      return step ?? { messageId: '<default>' };
    },
  };
  return tx;
}

function mockRes() {
  const r = {
    statusCode: null,
    headers: {},
    body: null,
    status(c) { r.statusCode = c; return r; },
    setHeader(k, v) { r.headers[k.toLowerCase()] = v; return r; },
    send(b) { r.body = b; return r; },
  };
  return r;
}

function mockReq(body, { method = 'POST', headers = {}, query = {} } = {}) {
  return { method, body, headers: { 'x-vercel-id': 'test-req', ...headers }, query };
}

const parse = (res) => JSON.parse(res.body);
