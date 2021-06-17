import Redis, { Cluster } from 'ioredis';
import allSettled from 'promise.allsettled';
import {
    GenericContainer,
    Network,
    StartedNetwork,
    StartedTestContainer,
    Wait,
} from 'testcontainers';
import { v4 as uuidv4 } from 'uuid';

import { PromiseCacheable } from '..';

class Docker {
    private cluster: StartedTestContainer | undefined;

    private standalone: StartedTestContainer | undefined;

    private network: StartedNetwork | undefined;

    private clusterPorts = [7000, 7001, 7002];

    async start() {
        this.network = await new Network().start();

        [this.cluster, this.standalone] = await Promise.all([
            new GenericContainer('grokzen/redis-cluster:latest')
                .withExposedPorts(...this.clusterPorts)
                .withNetworkMode(this.network.getName())
                .withEnv('MASTERS', '3')
                .withEnv('SLAVES_PER_MASTER', '0')
                .withWaitStrategy(
                    Wait.forLogMessage('Ready to accept connections')
                )
                .start(),
            new GenericContainer('redis:6').withExposedPorts(6379).start(),
        ]);
    }

    async stop() {
        await this.cluster?.stop();
        return Promise.all([this.network?.stop(), this.standalone?.stop()]);
    }

    getStandaloneConnection() {
        const container = this.standalone as StartedTestContainer;
        return {
            host: container.getHost(),
            port: container.getMappedPort(6379),
        };
    }

    getClusterConnection() {
        const container = this.cluster as StartedTestContainer;
        const network = this.network as StartedNetwork;

        const networkIpAddress = container.getIpAddress(network.getName());

        const dockerHost = container.getHost() || '';
        const hosts = this.clusterPorts.map((port) => {
            return {
                host: dockerHost,
                port: container.getMappedPort(port),
            };
        });

        const natMap = this.clusterPorts.reduce(
            (map: Record<string, { host: string; port: number }>, port) => {
                const hostPort = container.getMappedPort(port);
                const internalAddress = `${networkIpAddress}:${port}`;
                // eslint-disable-next-line no-param-reassign
                map[internalAddress] = { host: dockerHost, port: hostPort };
                return map;
            },
            {}
        );

        return { natMap, hosts };
    }
}

const docker = new Docker();

const serversType: Record<string, { clusterMode: boolean }> = {
    standalone: {
        clusterMode: false,
    },
    cluster: {
        clusterMode: true,
    },
};

const createRedisFactory = (serverType: string) => {
    const { clusterMode } = serversType[serverType];
    if (clusterMode) {
        const { hosts, natMap } = docker.getClusterConnection();
        return () => new Cluster(hosts, { natMap });
    }
    return () => new Redis(docker.getStandaloneConnection());
};

const defaultExecuteOptions = {
    cacheTimeout: 10 * 1000,
    waitTimeout: 10 * 1000,
};

beforeAll(async (done) => {
    await docker.start();
    done();
});

afterAll(async (done) => {
    await docker.stop();
    done();
});

test.each(Object.keys(serversType))(
    '%p: should return processed value',
    async (serverType) => {
        const cacheable = new PromiseCacheable(createRedisFactory(serverType));

        const result = await cacheable.call(
            { ...defaultExecuteOptions, key: uuidv4() },
            () => 'value'
        );

        expect(result).toEqual('value');

        cacheable.close();
    }
);

test.each(Object.keys(serversType))(
    '%p: should not process key if it has already been processed',
    async (serverType) => {
        const cacheable = new PromiseCacheable(createRedisFactory(serverType));
        const executeOptions = { ...defaultExecuteOptions, key: uuidv4() };

        const result = await cacheable.call(executeOptions, () => 'value');

        let twice = false;

        const result2 = await cacheable.call(executeOptions, () => {
            twice = true;
            return 'error';
        });

        expect(twice).toBeFalsy();
        expect(result2).toEqual(result);

        cacheable.close();
    }
);

test.each(Object.keys(serversType))(
    '%p: should wait for the process',
    async (serverType) => {
        const cacheable = new PromiseCacheable(createRedisFactory(serverType));
        const executeOptions = { ...defaultExecuteOptions, key: uuidv4() };

        const promise: Promise<string> = new Promise((resolve) => {
            setTimeout(() => resolve('slow value'), 2 * 1000);
        });

        const result = await cacheable.call(executeOptions, () => promise);

        expect(result).toEqual('slow value');
        expect(promise).resolves.toBeDefined();

        cacheable.close();
    }
);

test.each(Object.keys(serversType))(
    '%p: should not process the same key twice',
    async (serverType) => {
        const cacheable = new PromiseCacheable(createRedisFactory(serverType));
        const executeOptions = { ...defaultExecuteOptions, key: uuidv4() };

        let resultProcessed = false;
        let result2Processed = false;
        let result3Processed = false;

        const resultPromise = cacheable.call(executeOptions, () => {
            resultProcessed = true;
            return new Promise((resolve) => {
                setTimeout(() => resolve('slow value1'), 3 * 1000);
            });
        });

        const resultPromise2 = cacheable.call(executeOptions, () => {
            result2Processed = true;
            return new Promise((resolve) => {
                setTimeout(() => resolve('slow value2'), 3 * 1000);
            });
        });

        const resultPromise3 = cacheable.call(executeOptions, () => {
            result3Processed = true;
            return new Promise((resolve) => {
                setTimeout(() => resolve('slow value3'), 3 * 1000);
            });
        });

        const results = await Promise.all([
            resultPromise,
            resultPromise2,
            resultPromise3,
        ]);

        expect(
            [resultProcessed, result2Processed, result3Processed].filter(
                (processed) => processed
            ).length
        ).toEqual(1);

        if (resultProcessed) {
            expect(results.every((result) => result === 'slow value1'));
        } else if (result2Processed) {
            expect(results.every((result) => result === 'slow value2'));
        } else {
            expect(results.every((result) => result === 'slow value3'));
        }

        cacheable.close();
    }
);

test.each(Object.keys(serversType))(
    '%p: should process other calls in case of wait timeout happens on inflight process',
    async (serverType) => {
        const cacheable = new PromiseCacheable(createRedisFactory(serverType));
        const executeOptions = {
            ...defaultExecuteOptions,
            key: uuidv4(),
            waitTimeout: 1 * 1000,
        };

        const resultPromise = cacheable.call(
            executeOptions,
            () =>
                new Promise((resolve) => {
                    setTimeout(() => resolve('slow value'), 4 * 1000);
                })
        );

        let twice = false;
        const resultPromise2 = cacheable.call(executeOptions, () => {
            twice = true;
            return 'result2';
        });

        let twice2 = false;
        const resultPromise3 = cacheable.call(executeOptions, () => {
            twice2 = true;
            return 'result3';
        });

        const [result, result2, result3] = await Promise.all([
            resultPromise,
            resultPromise2,
            resultPromise3,
        ]);

        expect(result).toEqual('slow value');

        expect(twice).toBeTruthy();
        expect(result2).toEqual('result2');

        expect(twice2).toBeTruthy();
        expect(result3).toEqual('result3');

        cacheable.close();
    }
);

test.each(Object.keys(serversType))(
    '%p: should process other calls in case the wait timeout happens on inflight error',
    async (serverType) => {
        const cacheable = new PromiseCacheable(createRedisFactory(serverType));
        const executeOptions = {
            ...defaultExecuteOptions,
            key: uuidv4(),
        };

        const resultPromise = cacheable.call(
            executeOptions,
            () =>
                new Promise((resolve, reject) => {
                    setTimeout(() => reject(new Error()), 2 * 1000);
                })
        );

        let twice = false;
        const resultPromise2 = cacheable.call(executeOptions, () => {
            twice = true;
            return 'result2';
        });

        let twice2 = false;
        const resultPromise3 = cacheable.call(executeOptions, () => {
            twice2 = true;
            return 'result3';
        });

        const [, result2, result3] = await allSettled.call(Promise, [
            resultPromise,
            resultPromise2,
            resultPromise3,
        ]);

        expect(twice).toBeTruthy();
        expect((result2 as { value: string }).value).toEqual('result2');

        expect(twice2).toBeTruthy();
        expect((result3 as { value: string }).value).toEqual('result3');

        cacheable.close();
    }
);

test.each(Object.keys(serversType))(
    '%p: should respect the cache timeout',
    async (serverType) => {
        const cacheable = new PromiseCacheable(createRedisFactory(serverType));
        const executeOptions = {
            ...defaultExecuteOptions,
            key: uuidv4(),
            cacheTimeout: 2 * 1000,
        };

        const result = await cacheable.call(executeOptions, () => 'value');
        const result2 = await cacheable.call(executeOptions, () => 'result2');

        expect(result2).toEqual(result);

        await new Promise((resolve) => {
            setTimeout(resolve, executeOptions.cacheTimeout + 1 * 1000);
        });

        const result3 = await cacheable.call(executeOptions, () => 'result3');

        expect(result3).toEqual('result3');

        cacheable.close();
    }
);

test('standalone: should ignore cache if redis is out', async () => {
    const redisFactory = () =>
        new Redis({
            port: 0,
            commandTimeout: 2,
        });

    const cacheable = new PromiseCacheable(redisFactory);

    const executeOptions = {
        ...defaultExecuteOptions,
        key: uuidv4(),
    };

    const result = await cacheable.call(executeOptions, () => 'result');

    const result2 = await cacheable.call(executeOptions, () => 'result2');
    const result3 = await cacheable.call(executeOptions, () => 'result3');

    expect(result).toEqual('result');
    expect(result2).toEqual('result2');
    expect(result3).toEqual('result3');

    const [result4, result5, result6] = await Promise.all([
        cacheable.call(executeOptions, () => 'result4'),
        cacheable.call(executeOptions, () => 'result5'),
        cacheable.call(executeOptions, () => 'result6'),
    ]);

    expect(result4).toEqual('result4');
    expect(result5).toEqual('result5');
    expect(result6).toEqual('result6');

    cacheable.close();
});

test.each(Object.keys(serversType))(
    '%p: should support object values',
    async (serverType) => {
        const cacheable = new PromiseCacheable(createRedisFactory(serverType));

        const executeOptions = {
            ...defaultExecuteOptions,
            key: uuidv4(),
        };

        const processedValue = {
            id: 'id',
            name: 'name',
        };

        const result = JSON.parse(
            await cacheable.call(executeOptions, () => processedValue)
        );

        const result2 = JSON.parse(
            await cacheable.call(executeOptions, () => processedValue)
        );

        expect(result).toStrictEqual(processedValue);

        // returned by redis cache
        expect(result2).toStrictEqual(processedValue);

        cacheable.close();
    }
);
