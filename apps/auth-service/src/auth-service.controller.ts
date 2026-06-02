import { Controller, Inject, Logger, OnModuleInit } from '@nestjs/common';
import { GrpcMethod } from '@nestjs/microservices';
import type { ClientGrpc } from '@nestjs/microservices';
import { JwtService } from '@nestjs/jwt'; // Import JwtService
import { Observable, lastValueFrom, timeout } from 'rxjs';
import { AuthServiceService } from './auth-service.service';

interface EmailService {
  sendOtpEmail(data: { email: string; otp: string; name?: string }): Observable<any>;
}

// Cap how long we'll wait on the email-service so a stalled dependency
// can't hang login/registration indefinitely.
const EMAIL_SEND_TIMEOUT_MS = 5000;

@Controller()
export class AuthServiceController implements OnModuleInit {
  private readonly logger = new Logger(AuthServiceController.name);
  private emailService: EmailService;

  constructor(
    private readonly authService: AuthServiceService,
    private readonly jwtService: JwtService, // Inject JwtService
    @Inject('EMAIL_SERVICE') private client: ClientGrpc,
  ) { }

  onModuleInit() {
    this.emailService = this.client.getService<EmailService>('EmailService');
  }

  private sendOtpEmail(data: { email: string; otp: string; name?: string }): Promise<any> {
    return lastValueFrom(
      this.emailService.sendOtpEmail(data).pipe(timeout(EMAIL_SEND_TIMEOUT_MS)),
    );
  }

  @GrpcMethod('AuthService', 'RegisterUser')
  async registerUser(data: { name: string; email: string }): Promise<{ success: boolean; message: string }> {
    this.logger.log(`RegisterUser request for ${data?.email}`);
    // Logic:
    // 1. Generate OTP
    try {
      const otp = this.authService.generateOtp();
      // 2. Store in Redis
      await this.authService.storeTempRegistration(data.email, data.name, otp);

      // 3. Send Email
      await this.sendOtpEmail({ email: data.email, otp, name: data.name });
      return { success: true, message: 'OTP sent to email' };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      this.logger.error(`Error in RegisterUser: ${message}`);
      return { success: false, message: 'Failed to process registration' };
    }
  }

  @GrpcMethod('AuthService', 'VerifyRegistration')
  async verifyRegistration(data: { email: string; otp: string }): Promise<{ success: boolean; message: string; accessToken?: string; user?: any }> {
    this.logger.log(`VerifyRegistration request for ${data?.email}`);
    const isValid = await this.authService.verifyTempOtp(data.email, data.otp);
    if (!isValid) {
      return { success: false, message: 'Invalid OTP' };
    }
    const user = await this.authService.createUser(data.email);
    // Real JWT Generation matching frontend interface
    const payload = {
      userId: user.id.toString(),
      sub: user.id,
      email: user.email,
      name: user.name
    };
    const accessToken = this.jwtService.sign(payload);

    return {
      success: true,
      message: 'User registered successfully',
      accessToken,
      user
    };
  }

  @GrpcMethod('AuthService', 'LoginInit')
  async loginInit(data: { email: string }): Promise<{ success: boolean; message: string }> {
    this.logger.log(`[LoginInit] Request received for: ${data.email}`);
    const userExists = await this.authService.checkUserExists(data.email);
    if (!userExists) {
      this.logger.log(`[LoginInit] User not found: ${data.email}`);
      return { success: false, message: 'User not found' };
    }
    const otp = this.authService.generateOtp();
    await this.authService.storeLoginOtp(data.email, otp);

    try {
      await this.sendOtpEmail({ email: data.email, otp });
      return { success: true, message: 'OTP sent to email' };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      this.logger.error(`[LoginInit] Failed to send email: ${message}`);
      return { success: false, message: 'Failed to send email' };
    }
  }

  @GrpcMethod('AuthService', 'LoginVerify')
  async loginVerify(data: { email: string; otp: string }): Promise<{ success: boolean; message: string; accessToken: string; user?: any }> {
    this.logger.log(`[LoginVerify] Verifying OTP for: ${data.email}`);
    const isValid = await this.authService.verifyLoginOtp(data.email, data.otp);
    if (isValid) {
      this.logger.log(`[LoginVerify] Success for ${data.email}`);
      const user = await this.authService.getUserByEmail(data.email);
      if (!user) {
        return { success: false, message: 'User not found', accessToken: '' };
      }
      const payload = {
        userId: user.id.toString(),
        sub: user.id,
        email: user.email,
        name: user.name
      };
      const accessToken = this.jwtService.sign(payload);
      return { success: true, message: 'Login successful', accessToken, user };
    }
    this.logger.log(`[LoginVerify] Invalid OTP for ${data.email}`);
    return { success: false, message: 'Invalid OTP', accessToken: '' };
  }

  @GrpcMethod('AuthService', 'UpdateProfile')
  async updateProfile(data: { id: number; name: string; email: string; mobileNumber: string }): Promise<{ success: boolean; message: string }> {
    this.logger.log(`[UpdateProfile] Request for user ID: ${data.id}`);
    return this.authService.updateUser(data.id, data.name, data.email, data.mobileNumber);
  }

  @GrpcMethod('AuthService', 'GetProfile')
  async getProfile(data: { id: number }): Promise<{ success: boolean; message: string; user?: any }> {
    this.logger.log(`[GetProfile] Request for user ID: ${data.id}`);
    const user = await this.authService.getUserById(data.id);
    if (!user) {
      return { success: false, message: 'User not found' };
    }
    return { success: true, message: 'Profile retrieved successfully', user };
  }

  @GrpcMethod('AuthService', 'InitiateEmailUpdate')
  async initiateEmailUpdate(data: { userId: number; newEmail: string }): Promise<{ success: boolean; message: string }> {
    this.logger.log(`[InitiateEmailUpdate] Request for user ID: ${data.userId} to change email to: ${data.newEmail}`);

    const result = await this.authService.initiateEmailUpdate(data.userId, data.newEmail);

    if (result.success && result.otp) {
      // Send OTP email to the new email address
      try {
        await this.sendOtpEmail({ email: data.newEmail, otp: result.otp });
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        this.logger.error(`[InitiateEmailUpdate] Failed to send email: ${message}`);
        return { success: false, message: 'Failed to send verification email' };
      }
    }

    // Return without exposing the OTP
    return { success: result.success, message: result.message };
  }

  @GrpcMethod('AuthService', 'VerifyEmailUpdate')
  async verifyEmailUpdate(data: { userId: number; newEmail: string; otp: string }): Promise<{ success: boolean; message: string }> {
    this.logger.log(`[VerifyEmailUpdate] Verifying OTP for user ID: ${data.userId}`);
    return this.authService.verifyEmailUpdate(data.userId, data.newEmail, data.otp);
  }
}

