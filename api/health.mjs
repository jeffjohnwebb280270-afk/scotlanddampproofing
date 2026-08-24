/**
 * GET /api/health
 *
 * Answers one question in one request: is this deployment actually able to
 * deliver an enquiry right now? Returns 200 when yes, 503 when no.
 *
 * Never returns the mailbox password, or any prefix of it. `passPresent` plus
 * the `missing`/`warnings` lists distinguish the real failure modes (absent
 * credential / wrong credential type / bad host or port) without leaking a
 * secret to anyone who curls the URL.
 *
 * `?probe=1` additionally opens a real authenticated SMTP connection and
 * hangs up without sending. It is gated behind ENQUIRY_HEALTH_TOKEN so it
 * cannot be used to hammer the mail host or confirm credentials.
 */

import { resolveConfig } from '../lib/enquiry-core.mjs';
import { verifyTransport } from '../lib/smtp.mjs';

export default async function handler(req, res, deps = {}) {
  const env = deps.env ?? process.env;

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.setHeader('Allow', 'GET, HEAD');
    return json(res, 405, { error: 'Method not allowed' });
  }

  const { ok, missing, warnings, config } = resolveConfig(env);

  const body = {
    service: 'enquiry',
    status: ok ? 'ok' : 'misconfigured',
    transport: 'smtp',
    checkedAt: new Date().toISOString(),
    commit: env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) ?? null,
    env: env.VERCEL_ENV ?? 'unknown',
    config: {
      host: config.host,
      port: config.port,
      secure: config.secure,
      userPresent: config.user.length > 0,
      passPresent: (env.SMTP_PASS ?? '').length > 0,
      toEmail: config.toEmail,
      fromEmail: config.fromEmail,
      ackEnabled: config.sendAck,
    },
    missing,
    warnings,
  };

  const token = env.ENQUIRY_HEALTH_TOKEN;
  if (req.query?.probe === '1') {
    if (!token || req.headers?.['x-health-token'] !== token) {
      body.probe = { run: false, reason: 'probe requires a matching x-health-token header' };
    } else if (!ok) {
      body.probe = { run: false, reason: 'skipped — configuration is already invalid' };
    } else {
      const result = await verifyTransport(config, { transporter: deps.transporter });
      body.probe = result.ok
        ? { run: true, ok: true }
        : {
            run: true,
            ok: false,
            code: result.code,
            responseCode: result.responseCode,
            hint:
              result.responseCode === 535 || result.code === 'EAUTH'
                ? 'The mail host rejected the credentials. Check SMTP_USER and SMTP_PASS against the mailbox.'
                : `Could not complete an SMTP handshake with ${config.host}:${config.port}.`,
          };
      if (!body.probe.ok) body.status = 'degraded';
    }
  }

  res.setHeader('cache-control', 'no-store');
  return json(res, body.status === 'ok' ? 200 : 503, body);
}

function json(res, status, payload) {
  res.status(status).setHeader('content-type', 'application/json; charset=utf-8');
  return res.send(JSON.stringify(payload, null, 2));
}
