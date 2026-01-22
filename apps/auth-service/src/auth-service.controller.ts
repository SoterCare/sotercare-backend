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
    try {
      const otp = this.authService.generateOtp();
      // 2. Store in Redis
      await this.authService.storeTempRegistration(data.email, data.name, otp);

      // 3. Send Email
      await lastValueFrom(this.emailService.sendOtpEmail({ email: data.email, otp, name: data.name }));
      return { success: true, message: 'OTP sent to email' };
    } catch (e) {
      console.error('Error in RegisterUser:', e);
      return { success: false, message: 'Failed to process registration' };
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
    console.log(`[LoginInit] Request received for: ${data.email}`);
    const userExists = await this.authService.checkUserExists(data.email);
    if (!userExists) {
      console.log(`[LoginInit] User not found: ${data.email}`);
      return { success: false, message: 'User not found' };
    }
    const otp = this.authService.generateOtp();
    console.log(`[LoginInit] Generated OTP for ${data.email}: ${otp}`);
    await this.authService.storeLoginOtp(data.email, otp);

    try {
      await lastValueFrom(this.emailService.sendOtpEmail({ email: data.email, otp }));
      return { success: true, message: 'OTP sent to email' };
    } catch (e) {
      console.error(`[LoginInit] Failed to send email: ${e.message}`);
      return { success: false, message: 'Failed to send email' };
    }
  }

  @GrpcMethod('AuthService', 'LoginVerify')
  async loginVerify(data: { email: string; otp: string }): Promise<{ success: boolean; message: string; accessToken: string; user?: any }> {
    console.log(`[LoginVerify] Verifying OTP for: ${data.email}, OTP: ${data.otp}`);
    const isValid = await this.authService.verifyLoginOtp(data.email, data.otp);
    if (isValid) {
      console.log(`[LoginVerify] Success for ${data.email}`);
      const user = await this.authService.getUserByEmail(data.email);
      if (!user) {
        return { success: false, message: 'User not found', accessToken: '' };
      }
      const accessToken = Buffer.from(JSON.stringify({ sub: user.id, email: user.email })).toString('base64');
      return { success: true, message: 'Login successful', accessToken, user };
    }
    console.log(`[LoginVerify] Invalid OTP for ${data.email}`);
    return { success: false, message: 'Invalid OTP', accessToken: '' };
  }

  @GrpcMethod('AuthService', 'UpdateProfile')
  async updateProfile(data: { id: number; name: string; email: string; mobileNumber: string }): Promise<{ success: boolean; message: string }> {
    console.log(`[UpdateProfile] Request for user ID: ${data.id}`);
    return this.authService.updateUser(data.id, data.name, data.email, data.mobileNumber);
  }
}
