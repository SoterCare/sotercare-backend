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
                const host = configService.get<string>('REDIS_HOST', '127.0.0.1');
                const port = configService.get<number>('REDIS_PORT', 6379);

                const client = createClient({
                    url: `redis://${host}:${port}`,
                });

                client.on('error', (err) => console.error('Redis Client Error', err));
                await client.connect();

                console.log(`[ApiGateway] Redis Connected to ${host}:${port}`);
                return client;
            },
            inject: [ConfigService],
        },
    ],
    exports: ['REDIS_CLIENT'],
})
export class RedisModule { }
