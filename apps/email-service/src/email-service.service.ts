import { Injectable, Logger } from '@nestjs/common';
import { Resend } from 'resend';

@Injectable()
export class EmailServiceService {
  private readonly logger = new Logger(EmailServiceService.name);
  private readonly resend: Resend;

  constructor() {
    this.resend = new Resend(process.env.RESEND_API_KEY);
  }

  async sendEmail(email: string, otp: string, name?: string): Promise<{ success: boolean; message: string }> {
    const displayName = name || 'there';
    this.logger.log(`Sending OTP Email to ${name ? name + ' <' + email + '>' : email}`);

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Your SoterCare Verification Code</title>
</head>
<body style="margin:0;padding:0;background-color:#f1f3f4;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Oxygen,Ubuntu,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="padding:40px 16px;">
    <tr>
      <td align="center">
        <table width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#ffffff;border-radius:8px;box-shadow:0 1px 3px rgba(0,0,0,0.12),0 1px 2px rgba(0,0,0,0.08);overflow:hidden;">

          <!-- Header -->
          <tr>
            <td style="background:#1a73e8;padding:28px 32px;text-align:center;">
              <span style="color:#ffffff;font-size:22px;font-weight:700;letter-spacing:-0.5px;">SoterCare</span>
            </td>
          </tr>

          <!-- Body -->
          <tr>
            <td style="padding:36px 32px 24px;">
              <p style="margin:0 0 8px;font-size:15px;color:#202124;line-height:1.6;">Hi ${displayName},</p>
              <p style="margin:0 0 28px;font-size:15px;color:#5f6368;line-height:1.6;">
                Use the verification code below to complete your sign-in to SoterCare.
                This code expires in <strong>5 minutes</strong>.
              </p>

              <!-- OTP Box -->
              <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:28px;">
                <tr>
                  <td align="center">
                    <div style="display:inline-block;border:2px solid #1a73e8;border-radius:8px;padding:16px 40px;background:#f8f9ff;">
                      <span style="font-size:36px;font-weight:700;letter-spacing:10px;color:#1a73e8;font-family:'Courier New',Courier,monospace;">${otp}</span>
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
                    <a href="https://sotercare.com/dashboard"
                      style="display:inline-block;background:#1a73e8;color:#ffffff;text-decoration:none;font-size:14px;font-weight:600;padding:12px 28px;border-radius:4px;letter-spacing:0.2px;">
                      Open Dashboard →
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
                <a href="https://sotercare.com/dashboard" style="color:#1a73e8;text-decoration:none;">sotercare.com</a>
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
      const { error } = await this.resend.emails.send({
        from: 'SoterCare <otp@sotercare.com>',
        to: [email],
        subject: 'Your SoterCare verification code',
        html,
      });

      if (error) {
        this.logger.error(`Resend API error: ${JSON.stringify(error)}`);
        return { success: false, message: error.message };
      }

      this.logger.log(`OTP email sent successfully to ${email}`);
      return { success: true, message: 'Email sent successfully' };
    } catch (err) {
      this.logger.error(`Failed to send email: ${err.message}`);
      return { success: false, message: err.message };
    }
  }
}
