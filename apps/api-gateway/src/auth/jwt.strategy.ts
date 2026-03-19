import { ExtractJwt, Strategy } from 'passport-jwt';
import { PassportStrategy } from '@nestjs/passport';
import { Injectable } from '@nestjs/common';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
    constructor() {
        super({
            jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
            ignoreExpiration: false,
            secretOrKey: process.env.JWT_SECRET || 'REMOVED-OLD-PUBLIC-FALLBACK',
        });
    }

    async validate(payload: any) {
        // Payload matches frontend interface: { userId, email, name, ... }
        return {
            userId: Number(payload.userId),
            email: payload.email,
            name: payload.name
        };
    }
}
