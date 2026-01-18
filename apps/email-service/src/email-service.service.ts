import { Injectable, Logger } from '@nestjs/common';

@Injectable()
export class EmailServiceService {
  private readonly logger = new Logger(EmailServiceService.name);

  sendEmail(email: string, otp: string, name?: string) {
    this.logger.log(`Sending OTP Email to ${name ? name + ' <' + email + '>' : email}`);
    this.logger.log(`Subject: Your Login OTP`);
    this.logger.log(`Body: Your OTP is: ${otp}`);
    // Real implementation would use Nodemailer or an API here
  }
}
