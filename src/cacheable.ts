import { Redis } from 'ioredis';
import winston, { Logger } from 'winston';

type RedisFactory = () => Redis;

type ConstructorOptions = {
    logger?: Logger;
};

type CallOptions = {
    key: string;
    cacheTimeout: number;
    waitTimeout: number;
};

type Result = string | unknown;

export class PromiseCacheable {
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
        callableFunction: () => Promise<Result> | Result
    ): Promise<string> {
        const { key } = options;
        const lockKey = `lock_${options.key}`;
        const notifyKey = `notify_${options.key}`;

        const safeSuccessCallback = async (result: Result) => {
            const resultAsString =
                typeof result === 'string' ? result : JSON.stringify(result);
            try {
                // atomic remove lock and setting cache
                await this.redis
                    .multi()
                    .set(key, resultAsString, 'PX', options.cacheTimeout)
                    .publish(notifyKey, resultAsString)
                    .del(lockKey)
                    .exec();
            } catch (e) {
                this.logger.error(`problems on success callback operations`, e);
            }
            return resultAsString;
        };

        const fromCache = await this.safeGetFromCache(key);

        if (fromCache) {
            return Promise.resolve(fromCache);
        }

        const lock = await this.safeGetLock(lockKey, options.waitTimeout);

        if (lock) {
            const result: Result = await Promise.resolve(
                await callableFunction()
            );
            return safeSuccessCallback(result);
        }
        const subRedis = this.redisFactory();

        return this.safeSubscribe(subRedis, key, notifyKey, options.waitTimeout)
            .finally(() => {
                this.safeDisconnectRedis(subRedis);
            })
            .catch(async () => {
                const result = await Promise.resolve(callableFunction());
                return safeSuccessCallback(result);
            });
    }

    close(): void {
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
        timeout: number
    ): Promise<string> {
        // eslint-disable-next-line no-async-promise-executor
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

                // race condition between check and subscribe
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
