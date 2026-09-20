/**
 * Real email, over SMTP.
 *
 * Every other channel here (LinkedIn, SMS, voice) stays simulated — no
 * provider is wired for them, and the thread says so. Email is the one
 * channel with an actual transport behind it now: Nodemailer, against
 * whatever SMTP account is in the environment. Unset the SMTP variables and
 * this behaves exactly as it did before it existed — nothing crashes,
 * `sendMail` returns a clear "not configured" result, and the caller records
 * the send as simulated, same as any other channel.
 *
 * One transporter, built once and reused. Nodemailer pools connections
 * itself; building a new transporter per send would open a new SMTP
 * connection per message, which is slow and some providers rate-limit on.
 */
import nodemailer from 'nodemailer';
import { env, isMailerConfigured } from '../config.js';

let transporter = null;
let verifyError = null;

function getTransporter() {
  if (!isMailerConfigured()) return null;
  if (transporter) return transporter;

  transporter = nodemailer.createTransport({
    host: env.SMTP_HOST,
    port: env.SMTP_PORT,
    secure: env.SMTP_SECURE,
    auth: { user: env.SMTP_USER, pass: env.SMTP_PASS },
    connectionTimeout: env.SMTP_TIMEOUT_MS,
    greetingTimeout: env.SMTP_TIMEOUT_MS,
    socketTimeout: env.SMTP_TIMEOUT_MS,
  });

  return transporter;
}

/**
 * Checks the SMTP credentials actually work, without sending anything. Used
 * by the Controls/Agents screen so a wrong password shows up as "checked,
 * rejected" rather than as the next real message failing to send.
 */
export async function verifyMailer() {
  const t = getTransporter();
  if (!t) {
    return { ok: false, configured: false, error: 'SMTP_HOST, SMTP_USER and SMTP_PASS are not all set.' };
  }
  try {
    await t.verify();
    verifyError = null;
    return { ok: true, configured: true };
  } catch (err) {
    verifyError = err.message;
    return { ok: false, configured: true, error: err.message };
  }
}

export function mailerStatus() {
  return {
    configured: isMailerConfigured(),
    host: env.SMTP_HOST || null,
    from: env.SMTP_FROM || env.SMTP_USER || null,
    sandbox_to: env.SMTP_SANDBOX_TO || null,
    last_verify_error: verifyError,
  };
}

/**
 * Sends one email. Never throws — every failure mode (not configured, no
 * recipient, the provider rejecting the send) comes back as
 * `{ sent: false, error }` so the caller can record the real outcome on the
 * message row instead of the pipeline crashing on a bounce.
 *
 * In sandbox mode (`SMTP_SANDBOX_TO` set), every send goes to that one inbox
 * regardless of the prospect's actual address — including a prospect with no
 * email on record at all, which is the point: you can run a real campaign
 * against hand-typed or seed prospects and watch the whole approve-and-send
 * path actually fire, without needing a real inbox for every test person and
 * without risking a real send while you are still testing. The prospect's
 * real (or missing) address is never hidden — it is folded into the subject
 * line and returned to the caller, so the activity log still says who this
 * was actually for.
 */
export async function sendEmail({ to, subject, body, fromName, replyTo }) {
  const sandbox = env.SMTP_SANDBOX_TO || null;
  const intendedFor = to || (sandbox ? 'no address on record' : null);

  if (!sandbox && !to) {
    return { sent: false, error: 'This prospect has no email address on record.' };
  }

  const t = getTransporter();
  if (!t) {
    return { sent: false, error: 'SMTP is not configured, so this send was simulated.', simulated: true };
  }

  const fromAddress = env.SMTP_FROM || env.SMTP_USER;
  const actualTo = sandbox || to;
  const actualSubject = sandbox
    ? `[sandbox → would go to ${intendedFor}] ${subject?.trim() || '(no subject)'}`
    : subject?.trim() || '(no subject)';

  try {
    const info = await t.sendMail({
      from: fromName ? `"${fromName.replace(/"/g, '')}" <${fromAddress}>` : fromAddress,
      to: actualTo,
      replyTo: replyTo || undefined,
      subject: actualSubject,
      text: sandbox ? `Intended recipient: ${intendedFor}\n${'─'.repeat(40)}\n\n${body}` : body,
    });

    // A provider can accept the connection and still reject every recipient
    // (a typo'd address, a full mailbox). `rejected` carries those; `sent`
    // being empty with no thrown error is the one case worth treating as a
    // failure even though nothing threw.
    if (info.rejected?.length > 0 && info.accepted?.length === 0) {
      return { sent: false, error: `Rejected by the mail server: ${info.rejected.join(', ')}` };
    }

    return {
      sent: true,
      message_id: info.messageId,
      response: info.response,
      ...(sandbox ? { sandboxed: true, intended_for: intendedFor, actually_sent_to: actualTo } : {}),
    };
  } catch (err) {
    return { sent: false, error: err.message };
  }
}
