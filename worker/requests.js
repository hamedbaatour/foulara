import {DurableObject} from 'cloudflare:workers';
import nodemailer from 'nodemailer';
import {notification} from './validation.js';

// One object per idempotency key; separate objects enforce per-client rate limits.
// SQLite-backed storage survives Worker restarts and deployments.
export class CustomerRequest extends DurableObject {
  async limit() {
    return this.ctx.storage.transaction(async storage => {
      const now = Date.now();
      const recent = (await storage.get('timestamps') || []).filter(time => time > now - 600_000);
      if (recent.length >= 10) return false;
      await storage.put('timestamps', [...recent, now]);
      await storage.setAlarm(now + 600_000);
      return true;
    });
  }

  async record(kind, payload, fingerprint) {
    return this.ctx.storage.transaction(async storage => {
      const existing = await storage.get('request');
      if (existing) return existing.fingerprint === fingerprint
        ? {status: 200, reference: existing.reference}
        : {status: 409, error: 'request_changed'};
      const now = new Date();
      const reference = `${kind === 'preorder' ? 'FL' : 'FM'}-${now.toISOString().slice(2, 10).replaceAll('-', '')}-${crypto.randomUUID().replaceAll('-', '').slice(0, 12).toUpperCase()}`;
      await storage.put('request', {reference, kind, payload, fingerprint, created_at: now.toISOString(), attempts: 0, notified_at: null});
      await storage.setAlarm(Date.now() + 1000);
      return {status: 201, reference};
    });
  }

  async alarm() {
    const record = await this.ctx.storage.get('request');
    if (!record) {
      await this.ctx.storage.deleteAll(); // Expired rate-limit object; no customer data.
      return;
    }
    if (record.notified_at) return;
    // Keep a durable request even before a sending account is connected.
    // Hourly checks resume email delivery after secrets are configured.
    if (!this.env.SMTP_USER || !this.env.SMTP_PASSWORD) {
      await this.ctx.storage.setAlarm(Date.now() + 3600_000);
      return;
    }
    const transport = nodemailer.createTransport({
      host: 'smtp.gmail.com', port: 465, secure: true,
      auth: {user: this.env.SMTP_USER, pass: this.env.SMTP_PASSWORD},
      connectionTimeout: 15_000, greetingTimeout: 15_000, socketTimeout: 20_000,
      disableFileAccess: true, disableUrlAccess: true
    });
    // Schedule recovery before network I/O so interrupted executions cannot lose retries.
    const delay = Math.min(3600_000, 60_000 * 2 ** Math.min(record.attempts, 6));
    await this.ctx.storage.setAlarm(Date.now() + delay);
    try {
      const result = await transport.sendMail(notification(record, this.env.SMTP_FROM || this.env.SMTP_USER));
      if (!result.accepted?.length || result.rejected?.length) throw new Error('recipient_rejected');
      await this.ctx.storage.put('request', {...record, notified_at: new Date().toISOString(), last_error: null});
      await this.ctx.storage.deleteAlarm();
    } catch {
      await this.ctx.storage.put('request', {...record, attempts: record.attempts + 1, last_error: 'smtp_delivery_failed'});
      console.warn('Notification pending retry', record.reference);
    } finally {
      transport.close();
    }
  }
}
