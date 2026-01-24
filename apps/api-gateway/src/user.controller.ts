import { Body, Controller, Get, Inject, OnModuleInit, Post, Query, UseInterceptors } from '@nestjs/common';
import type { ClientGrpc } from '@nestjs/microservices';
import { Observable, lastValueFrom } from 'rxjs';
import { ApiTags, ApiOperation, ApiBody, ApiProperty, ApiQuery } from '@nestjs/swagger';
import { IdempotencyInterceptor } from './common/interceptors/idempotency.interceptor';

class UpdateProfileDto {
    @ApiProperty({ example: 1 })
    id: number;
    @ApiProperty({ example: 'John Doe' })
    name: string;
    @ApiProperty({ example: 'john@example.com' })
    email: string;
    @ApiProperty({ example: '+1234567890' })
    mobileNumber: string;
}

class InitiateEmailUpdateDto {
    @ApiProperty({ example: 1 })
    userId: number;
    @ApiProperty({ example: 'newemail@example.com' })
    newEmail: string;
}

class VerifyEmailUpdateDto {
    @ApiProperty({ example: 1 })
    userId: number;
    @ApiProperty({ example: 'newemail@example.com' })
    newEmail: string;
    @ApiProperty({ example: '123456' })
    otp: string;
}

interface AuthService {
    updateProfile(data: { id: number; name: string; email: string; mobileNumber: string }): Observable<{ success: boolean; message: string }>;
    getProfile(data: { id: number }): Observable<{ success: boolean; message: string; user?: any }>;
    initiateEmailUpdate(data: { userId: number; newEmail: string }): Observable<{ success: boolean; message: string }>;
    verifyEmailUpdate(data: { userId: number; newEmail: string; otp: string }): Observable<{ success: boolean; message: string }>;
}

@ApiTags('user')
@Controller('user')
@UseInterceptors(IdempotencyInterceptor)
export class UserController implements OnModuleInit {
    private authService: AuthService;

    constructor(@Inject('AUTH_SERVICE') private client: ClientGrpc) { }

    onModuleInit() {
        this.authService = this.client.getService<AuthService>('AuthService');
    }

    @Get('profile')
    @ApiOperation({ summary: 'Get user profile' })
    @ApiQuery({ name: 'id', required: true, example: 1 })
    async getProfile(@Query('id') id: number) {
        return lastValueFrom(this.authService.getProfile({ id: Number(id) }));
    }

    @Post('update')
    @ApiOperation({ summary: 'Update user profile (name, mobile number only - email requires verification)' })
    @ApiBody({ type: UpdateProfileDto })
    async updateProfile(@Body() body: UpdateProfileDto) {
        return lastValueFrom(this.authService.updateProfile(body));
    }

    @Post('email/initiate')
    @ApiOperation({ summary: 'Initiate email update - sends OTP to new email' })
    @ApiBody({ type: InitiateEmailUpdateDto })
    async initiateEmailUpdate(@Body() body: InitiateEmailUpdateDto) {
        return lastValueFrom(this.authService.initiateEmailUpdate(body));
    }

    @Post('email/verify')
    @ApiOperation({ summary: 'Verify email update - confirms OTP and updates email' })
    @ApiBody({ type: VerifyEmailUpdateDto })
    async verifyEmailUpdate(@Body() body: VerifyEmailUpdateDto) {
        return lastValueFrom(this.authService.verifyEmailUpdate(body));
    }
}

