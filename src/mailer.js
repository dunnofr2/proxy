import nodemailer from "nodemailer";

let cachedTransporter = null;

export function getConfiguredDeliveryMode() {
  if (process.env.RESEND_API_KEY) return "resend";
  if (process.env.SMTP_HOST || process.env.SMTP_URL) return "smtp";
  return "dev";
}

function getSmtpTransporter() {
  if (cachedTransporter) return cachedTransporter;

  if (process.env.SMTP_URL) {
    cachedTransporter = nodemailer.createTransport(process.env.SMTP_URL);
    return cachedTransporter;
  }

  const port = Number.parseInt(process.env.SMTP_PORT || "587", 10);
  const secure =
    process.env.SMTP_SECURE === "true" || port === 465;

  cachedTransporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port,
    secure,
    auth: process.env.SMTP_USER
      ? {
          user: process.env.SMTP_USER,
          pass: process.env.SMTP_PASS || "",
        }
      : undefined,
  });

  return cachedTransporter;
}

export async function sendVerificationEmail({ to, code, expiresMinutes = 10 }) {
  const mode = getConfiguredDeliveryMode();
  const subject = `Your Simple sign-in code: ${code}`;
  const text = `Your Simple verification code is: ${code}\n\nThis code expires in ${expiresMinutes} minutes. If you didn't request this, you can safely ignore this email.`;
  const html = `
    <div style="font-family:system-ui,-apple-system,sans-serif;max-width:440px;margin:0 auto;padding:24px;background:#141518;color:#e5e7eb;border-radius:12px;border:1px solid #2e3038;">
      <h2 style="margin:0 0 12px;color:#ffffff;">Simple</h2>
      <p style="margin:0 0 16px;color:#a1a1aa;font-size:14px;">Use this one-time code to finish signing in:</p>
      <div style="font-size:32px;font-weight:800;letter-spacing:0.22em;padding:14px 18px;text-align:center;background:#0a0a0c;border:1px solid #3c3e45;border-radius:10px;color:#ffffff;">${code}</div>
      <p style="margin:16px 0 0;color:#71717a;font-size:12px;">Expires in ${expiresMinutes} minutes.</p>
    </div>
  `;

  if (mode === "resend") {
    const from =
      process.env.EMAIL_FROM ||
      process.env.SMTP_FROM ||
      "Simple <onboarding@resend.dev>";
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ from, to: [to], subject, text, html }),
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`Resend email delivery failed (${res.status}): ${body.slice(0, 140)}`);
    }
    return { delivery: "resend" };
  }

  if (mode === "smtp") {
    const transporter = getSmtpTransporter();
    const from =
      process.env.EMAIL_FROM ||
      process.env.SMTP_FROM ||
      process.env.SMTP_USER ||
      "no-reply@localhost";
    await transporter.sendMail({ from, to, subject, text, html });
    return { delivery: "smtp" };
  }

  console.log(`[Auth Dev OTP] Code for ${to}: ${code} (expires in ${expiresMinutes}m)`);
  return { delivery: "dev", devCode: code };
}
