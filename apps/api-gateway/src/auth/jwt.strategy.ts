import { ExtractJwt, Strategy } from 'passport-jwt';
import { PassportStrategy } from '@nestjs/passport';
import { Injectable } from '@nestjs/common';

function requireJwtSecret(): string {
    const secret = process.env.JWT_SECRET;
    if (!secret) {
        throw new Error('JWT_SECRET environment variable must be set');
    }
    return secret;
}

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
    constructor() {
        super({
            jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
            ignoreExpiration: false,
            // H2: require a real secret instead of the public 'REMOVED-OLD-PUBLIC-FALLBACK' fallback.
            secretOrKey: requireJwtSecret(),
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
