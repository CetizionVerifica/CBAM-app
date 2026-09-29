import nodemailer from 'nodemailer';

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
}

export interface Mailer {
  send(message: MailMessage): Promise<void>;
}

export function smtpMailer(smtpUrl: string, from: string): Mailer {
  const transport = nodemailer.createTransport(smtpUrl);
  return {
    async send(m) {
      await transport.sendMail({ from, ...m });
    },
  };
}

/** Keeps messages in memory; used by tests. */
export function memoryMailer(): Mailer & { sent: MailMessage[] } {
  const sent: MailMessage[] = [];
  return {
    sent,
    async send(m) {
      sent.push(m);
    },
  };
}
