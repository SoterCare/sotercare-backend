import { Controller, Get, Module, UseGuards } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PassportModule } from '@nestjs/passport';
import * as jwt from 'jsonwebtoken';
import passport from 'passport';
import request from 'supertest';
import { JwtStrategy } from '../../auth/jwt.strategy';
import { JwtAuthGuard } from './jwt-auth.guard';

@Controller('protected')
@UseGuards(JwtAuthGuard)
class ProtectedController {
  @Get()
  getProtected() {
    return { ok: true };
  }
}

@Module({
  imports: [PassportModule.register({ defaultStrategy: 'jwt' })],
  controllers: [ProtectedController],
  providers: [JwtStrategy],
})
class TestAuthModule {}

describe('JwtAuthGuard', () => {
  it('rejects requests without a valid JWT and allows valid ones', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [TestAuthModule],
    }).compile();

    const app = moduleRef.createNestApplication();
    app.use(passport.initialize());
    await app.init();

    await request(app.getHttpServer()).get('/protected').expect(401);

    const token = jwt.sign(
      { userId: 1, email: 'test@example.com', name: 'Test User' },
      process.env.JWT_SECRET as string,
    );

    await request(app.getHttpServer())
      .get('/protected')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    await app.close();
  }, 10000);
});
