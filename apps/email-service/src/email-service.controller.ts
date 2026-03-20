import { Controller } from '@nestjs/common';
import { GrpcMethod } from '@nestjs/microservices';
import { EmailServiceService } from './email-service.service';

@Controller()
export class EmailServiceController {
  constructor(private readonly emailServiceService: EmailServiceService) { }

  @GrpcMethod('EmailService', 'SendOtpEmail')
  async sendOtpEmail(data: { email: string; otp: string; name?: string }): Promise<{ success: boolean; message: string }> {
    console.log('Received SendOtpEmail request:', data);
    return this.emailServiceService.sendEmail(data.email, data.otp, data.name);
  }
}
