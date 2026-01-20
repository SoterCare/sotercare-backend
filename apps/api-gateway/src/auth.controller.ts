import { Body, Controller, Inject, OnModuleInit, Post } from '@nestjs/common';
import type { ClientGrpc } from '@nestjs/microservices'; // Correct import with type
import type { Observable } from 'rxjs'; // import type
import { lastValueFrom } from 'rxjs';
import { ApiTags, ApiOperation, ApiBody, ApiProperty } from '@nestjs/swagger';

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

interface AuthService {
    registerUser(data: { name: string; email: string }): Observable<any>;
    verifyRegistration(data: { email: string; otp: string }): Observable<{ success: boolean; message: string; accessToken: string; user: any }>;
    loginInit(data: { email: string }): Observable<any>;
    loginVerify(data: { email: string; otp: string }): Observable<{ success: boolean; message: string; accessToken: string; user: any }>;
}

@ApiTags('auth')
@Controller('auth')
export class AuthController implements OnModuleInit {
    private authService: AuthService;

    constructor(@Inject('AUTH_SERVICE') private client: ClientGrpc) { }

    onModuleInit() {
        this.authService = this.client.getService<AuthService>('AuthService');
    }

    @Post('register')
    @ApiOperation({ summary: 'Register a new user' })
    @ApiBody({ type: RegisterDto })
    async register(@Body() body: RegisterDto) {
        try {
            return await lastValueFrom(this.authService.registerUser(body));
        } catch (e) {
            console.error('Register API Error:', e);
            throw e;
        }
    }

    @Post('verify')
    @ApiOperation({ summary: 'Verify registration OTP' })
    @ApiBody({ type: VerifyDto })
    async verify(@Body() body: VerifyDto) {
        try {
            return await lastValueFrom(this.authService.verifyRegistration(body));
        } catch (e) {
            console.error('Verify API Error:', e);
            throw e;
        }
    }

    @Post('login')
    @ApiOperation({ summary: 'Initiate login' })
    @ApiBody({ type: LoginDto })
    async login(@Body() body: LoginDto) {
        try {
            return await lastValueFrom(this.authService.loginInit(body));
        } catch (e) {
            console.error('Login API Error:', e);
            throw e;
        }
    }

    @Post('login-verify')
    @ApiOperation({ summary: 'Verify login OTP' })
    @ApiBody({ type: VerifyDto })
    async loginVerify(@Body() body: VerifyDto) {
        try {
            return await lastValueFrom(this.authService.loginVerify(body));
        } catch (e) {
            console.error('Login Verify API Error:', e);
            throw e;
        }
    }
}
