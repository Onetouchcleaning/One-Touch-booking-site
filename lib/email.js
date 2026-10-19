'use strict';

/**
 * Email via Gmail SMTP (nodemailer). Configure with:
 *   GMAIL_USER          e.g. onetouchcleaning.bf@gmail.com
 *   GMAIL_APP_PASSWORD  Gmail App Password (not the account password)
 * If not configured, emails are logged to the console instead of sent.
 */

const nodemailer = require('nodemailer');
const { formatTime12, formatDateLong } = require('./hours');

let transporter = null;

function isConfigured() {
  return Boolean(process.env.GMAIL_USER && process.env.GMAIL_APP_PASSWORD);
}

function getTransporter() {
  if (!isConfigured()) return null;
  if (!transporter) {
    transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD },
    });
  }
  return transporter;
}

function money(cents) {
  return '$' + (cents / 100).toFixed(2);
}

function bookingLines(b) {
  return [
    `Service: ${b.service_name || 'Cleaning'}`,
    `Date: ${formatDateLong(b.date)}`,
    `Time: ${formatTime12(b.start_time)} – ${formatTime12(b.end_time)} (America/New_York)`,
    `Duration: ${(b.duration_minutes / 60).toFixed(1).replace(/\.0$/, '')} hours`,
    `Customer: ${b.customer_name}`,
    `Email: ${b.customer_email}`,
    `Phone: ${b.customer_phone || '—'}`,
    `Address: ${b.address || '—'}`,
    b.notes ? `Notes: ${b.notes}` : null,
    `Estimated total: ${money(b.total_estimate_cents)}`,
    `Deposit paid (non-refundable): ${money(b.deposit_cents)}`,
    `Remaining balance due: ${money(b.balance_cents)}`,
    `Booking code: ${b.booking_code}`,
  ].filter(Boolean).join('\n');
}

async function sendMail({ to, subject, text }) {
  const t = getTransporter();
  const from = process.env.GMAIL_USER || 'One Touch Cleaning';
  if (!t) {
    console.log(`[email:DRY-RUN] To: ${to}\nSubject: ${subject}\n${text}\n---`);
    return { dryRun: true };
  }
  await t.sendMail({ from: `"One Touch Cleaning" <${from}>`, to, subject, text });
  return { dryRun: false };
}

async function sendOwnerNotification(ownerEmail, b) {
  return sendMail({
    to: ownerEmail,
    subject: `New booking: ${b.customer_name} — ${formatDateLong(b.date)} at ${formatTime12(b.start_time)}`,
    text:
      `A new appointment was booked and the $${(b.deposit_cents / 100).toFixed(0)} deposit was paid.\n\n` +
      bookingLines(b),
  });
}

async function sendCustomerConfirmation(b) {
  return sendMail({
    to: b.customer_email,
    subject: `Booking confirmed — One Touch Cleaning (${b.booking_code})`,
    text:
      `Hi ${b.customer_name},\n\n` +
      `Your cleaning appointment is confirmed! Here are your details:\n\n` +
      bookingLines(b) +
      `\n\nYour $${(b.deposit_cents / 100).toFixed(0)} deposit is non-refundable. ` +
      `The remaining balance of ${money(b.balance_cents)} is due at the time of service.\n\n` +
      `Need to cancel or reschedule? Reply to this email or call/text (561) 294-9666.\n\n` +
      `Thank you for choosing One Touch Cleaning!`,
  });
}

async function sendReminder(b) {
  await sendMail({
    to: b.customer_email,
    subject: `Reminder: cleaning appointment tomorrow (${b.booking_code})`,
    text:
      `Hi ${b.customer_name},\n\nJust a friendly reminder of your cleaning appointment:\n\n` +
      bookingLines(b) +
      `\n\nSee you soon!\nOne Touch Cleaning — (561) 294-9666`,
  });
}

async function sendChangeNotice(ownerEmail, b, type, detail) {
  await sendMail({
    to: ownerEmail,
    subject: `${type === 'cancel' ? 'Cancellation' : 'Reschedule'} request — ${b.booking_code}`,
    text: `A customer requested a ${type}:\n\n${bookingLines(b)}\n\nRequest details:\n${detail}\n\nReview it in the admin dashboard.`,
  });
}

async function sendCustomerStatusNotice(b, headline, extra = '') {
  await sendMail({
    to: b.customer_email,
    subject: `${headline} — One Touch Cleaning (${b.booking_code})`,
    text: `Hi ${b.customer_name},\n\n${extra}\n\n${bookingLines(b)}\n\nQuestions? Call/text (561) 294-9666.`,
  });
}

module.exports = {
  isConfigured,
  sendMail,
  sendOwnerNotification,
  sendCustomerConfirmation,
  sendReminder,
  sendChangeNotice,
  sendCustomerStatusNotice,
  money,
};
