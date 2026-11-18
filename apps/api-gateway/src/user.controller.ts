import { Body, Controller, Get, Inject, OnModuleInit, Post, Query, UseInterceptors, UseGuards, Req } from '@nestjs/common';
import type { ClientGrpc } from '@nestjs/microservices';
import { Observable, lastValueFrom, timeout } from 'rxjs';
import { ApiTags, ApiOperation, ApiBody, ApiProperty, ApiQuery, ApiBearerAuth } from '@nestjs/swagger';
import { IdempotencyInterceptor } from './common/interceptors/idempotency.interceptor';
import { JwtAuthGuard } from './common/guards/jwt-auth.guard';
import { DevicesService } from './devices/devices.service';

class UpdateProfileDto {
    @ApiProperty({ example: 'John Doe' })
    name: string;
    // Email is handled separately
    @ApiProperty({ example: '+1234567890' })
    mobileNumber: string;
}

class InitiateEmailUpdateDto {
    @ApiProperty({ example: 'newemail@example.com' })
    newEmail: string;
}

class VerifyEmailUpdateDto {
    @ApiProperty({ example: 'newemail@example.com' })
    newEmail: string;
    @ApiProperty({ example: '123456' })
    otp: string;
}

// Cap how long we'll wait on the auth-service so a stalled dependency can't
// hang profile requests indefinitely.
const AUTH_GRPC_TIMEOUT_MS = 5000;

interface AuthService {
    updateProfile(data: { id: number; name: string; email: string; mobileNumber: string }): Observable<{ success: boolean; message: string }>;
    getProfile(data: { id: number }): Observable<{ success: boolean; message: string; user?: any }>;
    initiateEmailUpdate(data: { userId: number; newEmail: string }): Observable<{ success: boolean; message: string }>;
    verifyEmailUpdate(data: { userId: number; newEmail: string; otp: string }): Observable<{ success: boolean; message: string }>;
}

@ApiTags('user')
@ApiBearerAuth()
@Controller('user')
@UseGuards(JwtAuthGuard)
@UseInterceptors(IdempotencyInterceptor)
export class UserController implements OnModuleInit {
    private authService: AuthService;

    constructor(
        @Inject('AUTH_SERVICE') private client: ClientGrpc,
        private readonly devicesService: DevicesService
    ) { }

    onModuleInit() {
        this.authService = this.client.getService<AuthService>('AuthService');
    }

    @Get('profile')
    @ApiOperation({ summary: 'Get current user profile' })
    async getProfile(@Req() req: any) {
        // The profile lookup and the device check are independent — run both in
        // parallel, and use a lightweight EXISTS instead of fetching every device.
        const [profileResponse, hasClaimedDevice] = await Promise.all([
            lastValueFrom(this.authService.getProfile({ id: req.user.userId }).pipe(timeout(AUTH_GRPC_TIMEOUT_MS))),
            this.devicesService.hasAnyDevice(req.user.userId),
        ]);

        // Append hasClaimedDevice status dynamically
        if (profileResponse.success && profileResponse.user) {
            profileResponse.user.hasClaimedDevice = hasClaimedDevice;
        }

        return profileResponse;
    }

    @Post('update')
    @ApiOperation({ summary: 'Update user profile (name, mobile number only - email requires verification)' })
    @ApiBody({ type: UpdateProfileDto })
    async updateProfile(@Body() body: UpdateProfileDto, @Req() req: any) {
        // Email from token (should be immutable here, but we pass it as it was)
        // Actually, we should probably get current email from DB or Token. 
        // Token has email.
        return lastValueFrom(this.authService.updateProfile({
            id: req.user.userId,
            name: body.name,
            email: req.user.email, // Keep email same as token/current
            mobileNumber: body.mobileNumber
        }).pipe(timeout(AUTH_GRPC_TIMEOUT_MS)));
    }

    @Post('email/initiate')
    @ApiOperation({ summary: 'Initiate email update - sends OTP to new email' })
    @ApiBody({ type: InitiateEmailUpdateDto })
    async initiateEmailUpdate(@Body() body: InitiateEmailUpdateDto, @Req() req: any) {
        return lastValueFrom(this.authService.initiateEmailUpdate({ userId: req.user.userId, newEmail: body.newEmail }).pipe(timeout(AUTH_GRPC_TIMEOUT_MS)));
    }

    @Post('email/verify')
    @ApiOperation({ summary: 'Verify email update - confirms OTP and updates email' })
    @ApiBody({ type: VerifyEmailUpdateDto })
    async verifyEmailUpdate(@Body() body: VerifyEmailUpdateDto, @Req() req: any) {
        return lastValueFrom(this.authService.verifyEmailUpdate({ userId: req.user.userId, newEmail: body.newEmail, otp: body.otp }).pipe(timeout(AUTH_GRPC_TIMEOUT_MS)));
    }
}

