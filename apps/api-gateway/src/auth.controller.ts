import {
  Body,
  Controller,
  Inject,
  OnModuleInit,
  Post,
  UseGuards,
} from '@nestjs/common';
import type { ClientGrpc } from '@nestjs/microservices'; // Correct import with type
import { AuthThrottleGuard } from './common/guards/auth-throttle.guard';
import type { Observable } from 'rxjs'; // import type
import { lastValueFrom, timeout } from 'rxjs';
import { ApiTags, ApiOperation, ApiBody, ApiProperty } from '@nestjs/swagger';

// Cap how long we'll wait on the auth-service so a stalled dependency can't
// hang auth requests indefinitely.
const AUTH_GRPC_TIMEOUT_MS = 5000;

class RegisterDto {
  @ApiProperty({ example: 'John Doe' })
  name: string;
  @ApiProperty({ example: 'john@example.com' })
  email: string;
}

class VerifyDto {
  @ApiProperty({ example: 'john@example.com' })
  email: string;
  @ApiProperty({ example: '123456' })
  otp: string;
}

class LoginDto {
  @ApiProperty({ example: 'john@example.com' })
  email: string;
}

interface AuthReply {
  success: boolean;
  message: string;
  [key: string]: unknown;
}

interface AuthService {
  registerUser(data: { name: string; email: string }): Observable<AuthReply>;
  verifyRegistration(data: { email: string; otp: string }): Observable<{
    success: boolean;
    message: string;
    accessToken: string;
    user: Record<string, unknown>;
  }>;
  loginInit(data: { email: string }): Observable<AuthReply>;
  loginVerify(data: { email: string; otp: string }): Observable<{
    success: boolean;
    message: string;
    accessToken: string;
    user: Record<string, unknown>;
  }>;
}

@ApiTags('auth')
@Controller('auth')
// M8: dropped IdempotencyInterceptor — it cached OTP-send responses for 24h, so a
// reused Idempotency-Key returned a stale "OTP sent" without issuing a new code.
// H7: per-IP rate limiting to blunt OTP brute force / email bombing.
@UseGuards(AuthThrottleGuard)
export class AuthController implements OnModuleInit {
  private authService: AuthService;

  constructor(@Inject('AUTH_SERVICE') private client: ClientGrpc) {}

  onModuleInit() {
    this.authService = this.client.getService<AuthService>('AuthService');
  }

  @Post('register')
  @ApiOperation({ summary: 'Register a new user' })
  @ApiBody({ type: RegisterDto })
  async register(@Body() body: RegisterDto) {
    return lastValueFrom(
      this.authService.registerUser(body).pipe(timeout(AUTH_GRPC_TIMEOUT_MS)),
    );
  }

  @Post('verify')
  @ApiOperation({ summary: 'Verify registration OTP' })
  @ApiBody({ type: VerifyDto })
  async verify(@Body() body: VerifyDto) {
    return lastValueFrom(
      this.authService
        .verifyRegistration(body)
        .pipe(timeout(AUTH_GRPC_TIMEOUT_MS)),
    );
  }

  @Post('login')
  @ApiOperation({ summary: 'Initiate login' })
  @ApiBody({ type: LoginDto })
  async login(@Body() body: LoginDto) {
    return lastValueFrom(
      this.authService.loginInit(body).pipe(timeout(AUTH_GRPC_TIMEOUT_MS)),
    );
  }

  @Post('login-verify')
  @ApiOperation({ summary: 'Verify login OTP' })
  @ApiBody({ type: VerifyDto })
  async loginVerify(@Body() body: VerifyDto) {
    return lastValueFrom(
      this.authService.loginVerify(body).pipe(timeout(AUTH_GRPC_TIMEOUT_MS)),
    );
  }
}
