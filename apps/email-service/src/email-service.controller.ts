import { Controller, Logger } from '@nestjs/common';
import { GrpcMethod } from '@nestjs/microservices';
import { EmailServiceService } from './email-service.service';

@Controller()
export class EmailServiceController {
  private readonly logger = new Logger(EmailServiceController.name);

  constructor(private readonly emailServiceService: EmailServiceService) {}

  @GrpcMethod('EmailService', 'SendOtpEmail')
  async sendOtpEmail(data: {
    email: string;
    otp: string;
    name?: string;
  }): Promise<{ success: boolean; message: string }> {
    // Never log the OTP itself — it is a sensitive credential.
    this.logger.log(
      `Received SendOtpEmail request for ${data?.email ?? '<missing>'}`,
    );
    return this.emailServiceService.sendEmail(data.email, data.otp, data.name);
  }
}
