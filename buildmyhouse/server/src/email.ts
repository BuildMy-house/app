// Email delivery via Resend. When RESEND_API_KEY is unset (typical for local
// dev / self-hosting without an email account), full email content including
// any embedded link is logged to the console instead of being sent — feature
// parity for self-hosted users by reading links from server logs.

export interface EmailMessage {
  to: string;
  subject: string;
  html: string;
  text?: string;
}

export function getAppBaseUrl(): string {
  return process.env.APP_BASE_URL ?? 'http://localhost:3000';
}

export async function sendEmail(msg: EmailMessage): Promise<void> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    console.log(
      `[email:dev-fallback] RESEND_API_KEY not set — email not sent, content below.\n` +
        `To: ${msg.to}\nSubject: ${msg.subject}\n---\n${msg.text ?? msg.html}`,
    );
    return;
  }
  const from = process.env.RESEND_FROM_EMAIL;
  if (!from) {
    throw new Error('RESEND_FROM_EMAIL environment variable is required when RESEND_API_KEY is set');
  }
  const { Resend } = await import('resend');
  const resend = new Resend(apiKey);
  const { data, error } = await resend.emails.send({
    from,
    to: msg.to,
    subject: msg.subject,
    html: msg.html,
    ...(msg.text !== undefined ? { text: msg.text } : {}),
  });
  if (error) {
    throw new Error(`Resend send failed: ${error.message}`);
  }
  if (!data) {
    throw new Error('Resend send failed: no response body');
  }
}
