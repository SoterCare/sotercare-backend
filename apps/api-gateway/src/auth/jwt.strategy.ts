import { ExtractJwt, Strategy } from 'passport-jwt';
import { PassportStrategy } from '@nestjs/passport';
import { Injectable } from '@nestjs/common';
import { requireJwtSecret } from '../common/jwt-secret';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
    constructor() {
        super({
            jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
            ignoreExpiration: false,
            // H2: require a real secret; never a publicly known fallback (see common/jwt-secret.ts).
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
