// The one place this system builds an SMTP connection.
//
// Until now the only thing that sent mail was the nightly ticket reminder, which built its own
// transport inline. A second sender (estimates going to customers) made that a fork in the road:
// either two copies of the same configuration drift apart, or there is one place to change when
// the mail host does. This is that place.
//
// NOT CONFIGURED IS A NORMAL STATE, NOT AN ERROR. The office install has SMTP settings; the cloud
// server currently does not, and says so at boot ("Ticket reminder email job disabled because SMTP
// configuration is missing"). Callers need to distinguish "we could not send" from "this
// installation does not send mail at all", because only one of those is worth telling a user to
// go and fix. So `isConfigured()` is separate from `send()` rather than being discovered by
// catching an exception.
const nodemailer = require('nodemailer');
require('dotenv').config();

const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, FROM_EMAIL } = process.env;

// Built once and reused. Nodemailer pools connections behind this, so creating a transport per
// message would open a new TLS session for every send.
let transport = null;

function isConfigured() {
  return !!(SMTP_HOST && SMTP_PORT && SMTP_USER && SMTP_PASS);
}

// What to tell a user when it is not set up, naming the specific thing that is missing rather
// than "email is not configured" -- which sends them looking through everything.
function missingReason() {
  const gaps = [];
  if (!SMTP_HOST) gaps.push('SMTP_HOST');
  if (!SMTP_PORT) gaps.push('SMTP_PORT');
  if (!SMTP_USER) gaps.push('SMTP_USER');
  if (!SMTP_PASS) gaps.push('SMTP_PASS');
  return gaps.length ? `${gaps.join(', ')} ${gaps.length === 1 ? 'is' : 'are'} not set on this server` : '';
}

function getTransport() {
  if (!isConfigured()) return null;
  if (!transport) {
    transport = nodemailer.createTransport({
      host: SMTP_HOST,
      // 465 is implicit TLS; 587 and 25 start plain and upgrade. Getting this wrong produces a
      // hang rather than an error, which is a miserable thing to debug.
      port: Number(SMTP_PORT),
      secure: Number(SMTP_PORT) === 465,
      auth: { user: SMTP_USER, pass: SMTP_PASS },
    });
  }
  return transport;
}

// The address mail appears to come from. Falls back to the authenticating account, because most
// providers reject a From that the account is not allowed to send as.
function fromAddress() {
  return FROM_EMAIL || SMTP_USER || '';
}

// Resolves to { ok: true, messageId } or { ok: false, error }. It does not throw: every caller
// so far wants to report the failure to a person rather than turn it into a 500, and a send that
// fails is a normal outcome (a wrong address, a provider refusing) rather than a bug.
async function send({ to, subject, html, text, replyTo, attachments }) {
  if (!isConfigured()) return { ok: false, error: `Email is not set up on this server -- ${missingReason()}.` };
  try {
    const info = await getTransport().sendMail({
      from: fromAddress(),
      to,
      subject,
      html,
      // Some clients, and most spam filters, want a plain-text alternative. Sending HTML alone
      // measurably increases the chance of landing in a junk folder.
      text,
      replyTo: replyTo || undefined,
      attachments: attachments || undefined,
    });
    return { ok: true, messageId: info.messageId };
  } catch (err) {
    return { ok: false, error: err.message || 'The mail server refused the message.' };
  }
}

module.exports = { send, isConfigured, missingReason, fromAddress };
