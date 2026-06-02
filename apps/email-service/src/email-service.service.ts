import { Injectable, Logger } from '@nestjs/common';
import { Resend } from 'resend';

@Injectable()
export class EmailServiceService {
  private readonly logger = new Logger(EmailServiceService.name);
  private readonly resend: Resend;
  private readonly sendTimeoutMs = Number(process.env.EMAIL_SEND_TIMEOUT_MS) || 8000;

  constructor() {
    const apiKey = process.env.RESEND_API_KEY;
    if (!apiKey) {
      // Fail loudly at startup rather than with an opaque error on the first send.
      this.logger.error(
        'RESEND_API_KEY is not set — OTP emails will fail until it is configured.',
      );
    }
    this.resend = new Resend(apiKey);
  }

  async sendEmail(email: string, otp: string, name?: string): Promise<{ success: boolean; message: string }> {
    if (!email || !otp) {
      // Reject early instead of paying for a doomed Resend round-trip.
      this.logger.warn('Rejected OTP email: missing email or otp');
      return { success: false, message: 'email and otp are required' };
    }

    const displayName = name || 'there';
    this.logger.log(`Sending OTP Email to ${name ? name + ' <' + email + '>' : email}`);

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Your SoterCare Verification Code</title>
</head>
<body style="margin:0;padding:0;background-color:#ffffff;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Oxygen,Ubuntu,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="padding:40px 16px;">
    <tr>
      <td align="center">
        <table width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#ffffff;border:1px solid #e0e0e0;border-radius:8px;overflow:hidden;">

          <!-- Header -->
          <tr>
            <td style="background:#a0cbdb;padding:28px 32px;text-align:center;">
              <span style="color:#2f2f2f;font-size:22px;font-weight:700;letter-spacing:-0.5px;">SoterCare</span>
            </td>
          </tr>

          <!-- Body -->
          <tr>
            <td style="padding:36px 32px 24px;">
              <p style="margin:0 0 8px;font-size:15px;color:#2f2f2f;line-height:1.6;">Hi ${displayName},</p>
              <p style="margin:0 0 28px;font-size:15px;color:#5f6368;line-height:1.6;">
                Use the verification code below to complete your sign-in to SoterCare.
                This code expires in <strong>5 minutes</strong>.
              </p>

              <!-- OTP Box -->
              <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:28px;">
                <tr>
                  <td align="center">
                    <div style="display:inline-block;border:2px solid #a0cbdb;border-radius:8px;padding:16px 40px;background:#f0f7f9;">
                      <span style="font-size:36px;font-weight:700;letter-spacing:10px;color:#2f2f2f;font-family:'Courier New',Courier,monospace;">${otp}</span>
                    </div>
                  </td>
                </tr>
              </table>

              <p style="margin:0 0 28px;font-size:13px;color:#80868b;line-height:1.6;">
                If you did not request this code, you can safely ignore this email.
                Never share this code with anyone.
              </p>

              <!-- CTA Button -->
              <table width="100%" cellpadding="0" cellspacing="0">
                <tr>
                  <td align="center">
                    <a href="mailto:support@sotercare.com"
                      style="display:inline-block;background:#a0cbdb;color:#2f2f2f;text-decoration:none;font-size:14px;font-weight:600;padding:12px 28px;border-radius:4px;letter-spacing:0.2px;">
                      Support →
                    </a>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="padding:20px 32px;border-top:1px solid #e8eaed;text-align:center;">
              <p style="margin:0;font-size:12px;color:#80868b;line-height:1.6;">
                © ${new Date().getFullYear()} SoterCare &nbsp;·&nbsp;
                <a href="https://links.sotercare.com" style="color:#2f2f2f;text-decoration:none;">Connect With Us</a>
                &nbsp;·&nbsp; otp@sotercare.com
              </p>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;

    try {
      const { error } = await this.withTimeout<{
        error: { message: string } | null;
      }>(
        this.resend.emails.send({
          from: 'SoterCare <otp@sotercare.com>',
          to: [email],
          subject: 'Your SoterCare verification code',
          html,
        }),
        this.sendTimeoutMs,
      );

      if (error) {
        this.logger.error(`Resend API error: ${JSON.stringify(error)}`);
        return { success: false, message: error.message };
      }

      this.logger.log(`OTP email sent successfully to ${email}`);
      return { success: true, message: 'Email sent successfully' };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`Failed to send email: ${message}`);
      return { success: false, message };
    }
  }

  /**
   * Bounds an async operation so a slow/hung Resend call can't stall the gRPC
   * response — which sits on the critical path of login/registration upstream.
   */
  private async withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
    let timer: NodeJS.Timeout;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`Email send timed out after ${timeoutMs}ms`)),
        timeoutMs,
      );
    });
    try {
      return await Promise.race([promise, timeout]);
    } finally {
      clearTimeout(timer!);
    }
  }
}
