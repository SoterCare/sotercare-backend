import { Injectable, Inject, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { randomInt } from 'crypto';
import type { RedisClientType } from 'redis';
import { User } from './user.entity';

@Injectable()
export class AuthServiceService {
  private readonly logger = new Logger(AuthServiceService.name);

  constructor(
    @InjectRepository(User)
    private userRepository: Repository<User>,
    @Inject('REDIS_CLIENT')
    private redisClient: RedisClientType,
  ) { }

  generateOtp(): string {
    // Cryptographically secure — Math.random() is predictable and unsafe for OTPs.
    return randomInt(100000, 1000000).toString();
  }

  async storeTempRegistration(email: string, name: string, otp: string) {
    const key = `temp_reg:${email}`;
    // Store as JSON string, expires in 5 minutes (300 seconds)
    await this.redisClient.set(key, JSON.stringify({ name, otp }), { EX: 300 });
    // Never log the OTP — it is a live credential.
    this.logger.log(`Stored temp registration for ${email}`);
  }

  async verifyTempOtp(email: string, otp: string): Promise<boolean> {
    const key = `temp_reg:${email}`;
    const data = await this.redisClient.get(key);
    if (!data) return false;

    const parsed = this.safeParse(data);
    if (parsed?.otp === otp) {
      // Don't delete yet, needed for creation
      return true;
    }
    return false;
  }

  async createUser(email: string): Promise<User> {
    let user = await this.userRepository.findOneBy({ email });
    if (user) {
      this.logger.log(`User already exists: ${email}`);
      return user;
    }

    const key = `temp_reg:${email}`;
    const data = await this.redisClient.get(key);
    let name = 'Unknown';
    if (data) {
      const parsed = this.safeParse(data);
      if (parsed?.name) name = parsed.name;
      await this.redisClient.del(key); // Cleanup
    }

    user = this.userRepository.create({ email, name });
    await this.userRepository.save(user);
    this.logger.log(`User created (DB): ${email}`);
    return user;
  }

  /** Tolerates corrupted Redis values instead of throwing an opaque gRPC error. */
  private safeParse(data: string): { name?: string; otp?: string } | null {
    try {
      return JSON.parse(data);
    } catch {
      this.logger.warn('Failed to parse temp registration data from Redis');
      return null;
    }
  }

  async checkUserExists(email: string): Promise<boolean> {
    const count = await this.userRepository.count({ where: { email } });
    return count > 0;
  }

  async storeLoginOtp(email: string, otp: string) {
    const key = `login:${email}`;
    await this.redisClient.set(key, otp, { EX: 300 });
    this.logger.log(`Stored login OTP for ${email}`);
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

  async updateUser(id: number, name: string, email: string, mobileNumber: string): Promise<{ success: boolean; message: string }> {
    const user = await this.userRepository.findOneBy({ id });
    if (!user) {
      return { success: false, message: 'User not found' };
    }

    // Check if email is being changed and if it's already taken
    if (email !== user.email) {
      const existingUser = await this.userRepository.findOneBy({ email });
      if (existingUser) {
        return { success: false, message: 'Email already in use' };
      }
    }

    user.name = name;
    user.email = email;
    user.mobileNumber = mobileNumber;
    await this.userRepository.save(user);

    return { success: true, message: 'Profile updated successfully' };
  }

  async getUserById(id: number): Promise<User | null> {
    return this.userRepository.findOneBy({ id });
  }

  async initiateEmailUpdate(userId: number, newEmail: string): Promise<{ success: boolean; message: string; otp?: string }> {
    // Check if user exists
    const user = await this.userRepository.findOneBy({ id: userId });
    if (!user) {
      return { success: false, message: 'User not found' };
    }

    // Check if new email is same as current
    if (user.email === newEmail) {
      return { success: false, message: 'New email is the same as current email' };
    }

    // Check if new email is already taken by another user
    const existingUser = await this.userRepository.findOneBy({ email: newEmail });
    if (existingUser) {
      return { success: false, message: 'Email already in use by another account' };
    }

    // Generate OTP and store in Redis
    const otp = this.generateOtp();
    const key = `email_update:${userId}:${newEmail}`;
    await this.redisClient.set(key, otp, { EX: 300 }); // 5 min expiry
    this.logger.log(`[InitiateEmailUpdate] Stored email-update OTP for user ${userId} (${newEmail})`);

    return { success: true, message: 'Verification OTP sent to new email', otp };
  }

  async verifyEmailUpdate(userId: number, newEmail: string, otp: string): Promise<{ success: boolean; message: string }> {
    const key = `email_update:${userId}:${newEmail}`;
    const storedOtp = await this.redisClient.get(key);

    if (!storedOtp) {
      return { success: false, message: 'No pending email update or OTP expired' };
    }

    if (storedOtp !== otp) {
      return { success: false, message: 'Invalid OTP' };
    }

    // OTP is valid, update the email
    const user = await this.userRepository.findOneBy({ id: userId });
    if (!user) {
      return { success: false, message: 'User not found' };
    }

    user.email = newEmail;
    await this.userRepository.save(user);
    await this.redisClient.del(key); // Cleanup

    this.logger.log(`[VerifyEmailUpdate] User ${userId} email updated to ${newEmail}`);
    return { success: true, message: 'Email updated successfully' };
  }
}
