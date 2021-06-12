import { Redis } from 'ioredis';
import { Logger } from 'winston';
import winston from 'winston';

type RedisFactory = () => Redis;

type ConstructorOptions = {
    logger?: Logger;
};

type CallOptions = {
    key: string;
    cacheTimeout: number;
    waitTimeout: number;
};

export default class PromiseCacheable {
    private redis: Redis;
    private logger: Logger;

    constructor(
        private redisFactory: RedisFactory,
        options?: ConstructorOptions
    ) {
        this.redis = redisFactory();
        this.logger = options?.logger || winston.createLogger({ silent: true });
    }

    async call(
        options: CallOptions,
        callableFunction: () => Promise<string> | string
    ): Promise<string> {
        const key = options.key;
        const lockKey = `lock_${options.key}`;
        const notifyKey = `notify_${options.key}`;

        const safeSuccessCallback = async (result: string) => {
            try {
                //atomic remove lock and setting cache
                await this.redis
                    .multi()
                    .set(key, result, 'PX', options.cacheTimeout)
                    .publish(notifyKey, result)
                    .del(lockKey)
                    .exec();
            } catch (e) {
                this.logger.error(`problems on success callback operations`, e);
            } finally {
                return result;
            }
        };

        const fromCache = await this.safeGetFromCache(key);

        if (fromCache) {
            return Promise.resolve(fromCache);
        }

        const lock = await this.safeGetLock(lockKey, options.waitTimeout);

        if (lock) {
            let result = await Promise.resolve(await callableFunction());
            return safeSuccessCallback(result);
        } else {
            const subRedis = this.redisFactory();

            return await this.safeSubscribe(
                subRedis,
                key,
                notifyKey,
                options.waitTimeout,
                callableFunction
            )
                .finally(() => {
                    this.safeDisconnectRedis(subRedis);
                })
                .catch(async () => {
                    const result = await Promise.resolve(callableFunction());
                    return safeSuccessCallback(result);
                });
        }
    }

    close() {
        this.safeDisconnectRedis(this.redis);
    }

    private safeDisconnectRedis(redis: Redis) {
        try {
            redis.disconnect();
        } catch (e) {
            this.logger.error(`problems on disconnecting redis.`, e);
        }
    }

    private async safeGetFromCache(key: string) {
        try {
            return await this.redis.get(key);
        } catch (e) {
            this.logger.error(`problems on get from cache.`, e);
            return null;
        }
    }

    private async safeGetLock(key: string, timeout: number) {
        try {
            return await this.redis.set(key, key, 'PX', timeout, 'NX');
        } catch (e) {
            this.logger.error(`problems on setting lock.`, e);
            return 'OK';
        }
    }

    private safeSubscribe(
        subscriberConnection: Redis,
        key: string,
        notifyKey: string,
        timeout: number,
        callableFunction: () => Promise<string> | string
    ): Promise<string> {
        return new Promise(async (resolve, reject) => {
            let timeoutId: NodeJS.Timeout;

            const resolveCallback = (message: string) => {
                clearTimeout(timeoutId);
                resolve(message);
            };

            try {
                await subscriberConnection.subscribe(notifyKey);

                subscriberConnection.on('message', (channel, message) => {
                    resolveCallback(message);
                });

                //race condition between check and subscribe
                const doubleCheck = await this.redis.get(key);
                if (doubleCheck) {
                    resolveCallback(doubleCheck);
                }
            } catch (e) {
                this.logger.error(`problems on subscribing.`, e);
                reject(e);
            }

            timeoutId = setTimeout(async () => {
                reject();
            }, timeout);
        });
    }
}
