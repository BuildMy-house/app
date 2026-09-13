/**
 * Email service module - stub implementation for telemetry testing
 */

export interface EmailOptions {
  to: string;
  subject: string;
  text?: string;
  html?: string;
}

export function sendEmail(options: EmailOptions): Promise<void> {
  // Stub: In production, this would send via SMTP
  // For testing, we just log the email details
  console.log(JSON.stringify({ event: 'email_sent', ...options }));
  return Promise.resolve();
}

export function getAppBaseUrl(): string {
  return process.env.APP_BASE_URL || 'http://localhost:3000';
}
