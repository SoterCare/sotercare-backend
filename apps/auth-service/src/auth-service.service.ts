import { Injectable, Inject } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import type { RedisClientType } from 'redis';
import { User } from './user.entity';

@Injectable()
export class AuthServiceService {
  constructor(
    @InjectRepository(User)
    private userRepository: Repository<User>,
    @Inject('REDIS_CLIENT')
    private redisClient: RedisClientType,
  ) { }

  generateOtp(): string {
    return Math.floor(100000 + Math.random() * 900000).toString();
  }

  async storeTempRegistration(email: string, name: string, otp: string) {
    const key = `temp_reg:${email}`;
    // Store as JSON string, expires in 5 minutes (300 seconds)
    await this.redisClient.set(key, JSON.stringify({ name, otp }), { EX: 300 });
    console.log(`Stored Temp Reg (Redis): ${email}, OTP: ${otp}`);
  }

  async verifyTempOtp(email: string, otp: string): Promise<boolean> {
    const key = `temp_reg:${email}`;
    const data = await this.redisClient.get(key);
    if (!data) return false;

    const parsed = JSON.parse(data);
    if (parsed.otp === otp) {
      // Don't delete yet, needed for creation
      return true;
    }
    return false;
  }

  async createUser(email: string): Promise<User> {
    let user = await this.userRepository.findOneBy({ email });
    if (user) {
      console.log(`User already exists: ${email}`);
      return user;
    }

    const key = `temp_reg:${email}`;
    const data = await this.redisClient.get(key);
    let name = 'Unknown';
    if (data) {
      const parsed = JSON.parse(data);
      name = parsed.name;
      await this.redisClient.del(key); // Cleanup
    }

    user = this.userRepository.create({ email, name });
    await this.userRepository.save(user);
    console.log(`User created (DB): ${email}`);
    return user;
  }

  async checkUserExists(email: string): Promise<boolean> {
    const count = await this.userRepository.count({ where: { email } });
    return count > 0;
  }

  async storeLoginOtp(email: string, otp: string) {
    const key = `login:${email}`;
    await this.redisClient.set(key, otp, { EX: 300 });
    console.log(`Stored Login OTP (Redis): ${email}, OTP: ${otp}`);
  }

  async verifyLoginOtp(email: string, otp: string): Promise<boolean> {
    const key = `login:${email}`;
    const storedOtp = await this.redisClient.get(key);
    if (storedOtp === otp) {
      await this.redisClient.del(key);
      return true;
    }
    return false;
  }
  async getUserByEmail(email: string): Promise<User | null> {
    return this.userRepository.findOneBy({ email });
  }
}
