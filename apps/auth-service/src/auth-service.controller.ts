import { Controller, Inject, OnModuleInit } from '@nestjs/common';
import { GrpcMethod } from '@nestjs/microservices';
import type { ClientGrpc } from '@nestjs/microservices';
import { Observable, lastValueFrom, of } from 'rxjs';
import { AuthServiceService } from './auth-service.service';

interface EmailService {
  sendOtpEmail(data: { email: string; otp: string; name?: string }): Observable<any>;
}

@Controller()
export class AuthServiceController implements OnModuleInit {
  private emailService: EmailService;

  constructor(
    private readonly authService: AuthServiceService,
    @Inject('EMAIL_SERVICE') private client: ClientGrpc,
  ) { }

  onModuleInit() {
    this.emailService = this.client.getService<EmailService>('EmailService');
  }

  @GrpcMethod('AuthService', 'RegisterUser')
  async registerUser(data: { name: string; email: string }): Promise<{ success: boolean; message: string }> {
    console.log('RegisterUser', data);
    // Logic: 
    // 1. Generate OTP
    const otp = this.authService.generateOtp();
    // 2. Store in Redis (mocked/delegated to service)
    await this.authService.storeTempRegistration(data.email, data.name, otp);
    // 3. Send Email
    try {
      await lastValueFrom(this.emailService.sendOtpEmail({ email: data.email, otp, name: data.name }));
      return { success: true, message: 'OTP sent to email' };
    } catch (e) {
      return { success: false, message: 'Failed to send email' };
    }
  }

  @GrpcMethod('AuthService', 'VerifyRegistration')
  async verifyRegistration(data: { email: string; otp: string }): Promise<{ success: boolean; message: string; accessToken?: string; user?: any }> {
    console.log('VerifyRegistration', data);
    const isValid = await this.authService.verifyTempOtp(data.email, data.otp);
    if (!isValid) {
      return { success: false, message: 'Invalid OTP' };
    }
    const user = await this.authService.createUser(data.email);
    // Mock Token Generation
    const accessToken = Buffer.from(JSON.stringify({ sub: user.id, email: user.email })).toString('base64');

    return {
      success: true,
      message: 'User registered successfully',
      accessToken,
      user
    };
  }

  @GrpcMethod('AuthService', 'LoginInit')
  async loginInit(data: { email: string }): Promise<{ success: boolean; message: string }> {
    console.log('LoginInit', data);
    const userExists = await this.authService.checkUserExists(data.email);
    if (!userExists) {
      return { success: false, message: 'User not found' };
    }
    const otp = this.authService.generateOtp();
    await this.authService.storeLoginOtp(data.email, otp);

    try {
      await lastValueFrom(this.emailService.sendOtpEmail({ email: data.email, otp }));
      return { success: true, message: 'OTP sent to email' };
    } catch (e) {
      return { success: false, message: 'Failed to send email' };
    }
  }

  @GrpcMethod('AuthService', 'LoginVerify')
  async loginVerify(data: { email: string; otp: string }): Promise<{ success: boolean; message: string; accessToken: string }> {
    console.log('LoginVerify', data);
    const isValid = await this.authService.verifyLoginOtp(data.email, data.otp);
    if (isValid) {
      return { success: true, message: 'Login successful', accessToken: 'mock_jwt_token' };
    }
    return { success: false, message: 'Invalid OTP', accessToken: '' };
  }
}
