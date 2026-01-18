import { Body, Controller, Inject, OnModuleInit, Post } from '@nestjs/common';
import type { ClientGrpc } from '@nestjs/microservices'; // Correct import with type
import type { Observable } from 'rxjs'; // import type
import { lastValueFrom } from 'rxjs';

interface AuthService {
    registerUser(data: { name: string; email: string }): Observable<any>;
    verifyRegistration(data: { email: string; otp: string }): Observable<any>;
    loginInit(data: { email: string }): Observable<any>;
    loginVerify(data: { email: string; otp: string }): Observable<any>;
}

@Controller('auth')
export class AuthController implements OnModuleInit {
    private authService: AuthService;

    constructor(@Inject('AUTH_SERVICE') private client: ClientGrpc) { }

    onModuleInit() {
        this.authService = this.client.getService<AuthService>('AuthService');
    }

    @Post('register')
    async register(@Body() body: { name: string; email: string }) {
        return lastValueFrom(this.authService.registerUser(body));
    }

    @Post('verify')
    async verify(@Body() body: { email: string; otp: string }) {
        return lastValueFrom(this.authService.verifyRegistration(body));
    }

    @Post('login')
    async login(@Body() body: { email: string }) {
        return lastValueFrom(this.authService.loginInit(body));
    }

    @Post('login-verify')
    async loginVerify(@Body() body: { email: string; otp: string }) {
        return lastValueFrom(this.authService.loginVerify(body));
    }
}
