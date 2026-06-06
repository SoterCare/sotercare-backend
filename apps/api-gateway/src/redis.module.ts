import { Module, Global } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { createClient } from 'redis';

@Global()
@Module({
    imports: [ConfigModule],
    providers: [
        {
            provide: 'REDIS_CLIENT',
            useFactory: async (configService: ConfigService) => {
                // Prefer REDIS_URL (supports rediss:// + auth for managed Redis);
                // fall back to host/port for the embedded/local instance.
                const redisUrl = configService.get<string>('REDIS_URL');
                const host = configService.get<string>('REDIS_HOST', '127.0.0.1');
                const port = configService.get<number>('REDIS_PORT', 6379);
                const url = redisUrl || `redis://${host}:${port}`;

                const client = createClient({ url });

                client.on('error', (err) => console.error('Redis Client Error', err));
                await client.connect();

                console.log(`[ApiGateway] Redis Connected (${redisUrl ? 'REDIS_URL' : `${host}:${port}`})`);
                return client;
            },
            inject: [ConfigService],
        },
    ],
    exports: ['REDIS_CLIENT'],
})
export class RedisModule { }
