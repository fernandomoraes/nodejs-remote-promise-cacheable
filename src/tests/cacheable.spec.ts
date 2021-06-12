import Redis from 'ioredis';
import { v4 as uuidv4 } from 'uuid';
import { GenericContainer, StartedTestContainer } from 'testcontainers';

import PromiseCacheable from '../';

import allSettled from 'promise.allsettled';

let container: StartedTestContainer;

const defaultRedisFactory = () =>
    new Redis({
        host: container.getHost(),
        port: container.getMappedPort(6379),
    });

const defaultExecuteOptions = {
    cacheTimeout: 10 * 1000,
    waitTimeout: 10 * 1000,
};

beforeAll(async (done) => {
    container = await new GenericContainer('redis:6')
        .withExposedPorts(6379)
        .start();
    done();
});

afterAll(async (done) => {
    await container.stop();
    done();
});

test('should return processed value', async () => {
    const cacheable = new PromiseCacheable(defaultRedisFactory);
    const result = await cacheable.call(
        { ...defaultExecuteOptions, key: uuidv4() },
        () => 'value'
    );

    expect(result).toEqual('value');

    cacheable.close();
});

test('should not process key if it has already been processed', async () => {
    const cacheable = new PromiseCacheable(defaultRedisFactory);
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
});

test('should wait for the process', async () => {
    const cacheable = new PromiseCacheable(defaultRedisFactory);
    const executeOptions = { ...defaultExecuteOptions, key: uuidv4() };

    const promise: Promise<string> = new Promise((resolve) => {
        setTimeout(() => resolve('slow value'), 2 * 1000);
    });

    const result = await cacheable.call(executeOptions, () => promise);

    expect(result).toEqual('slow value');
    expect(promise).resolves.toBeDefined();

    cacheable.close();
});

test('should not process the same key twice', async () => {
    const cacheable = new PromiseCacheable(defaultRedisFactory);
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
});

test('should process other calls in case of wait timeout happens on inflight process', async () => {
    const cacheable = new PromiseCacheable(defaultRedisFactory);
    const executeOptions = {
        ...defaultExecuteOptions,
        key: uuidv4(),
        waitTimeout: 2 * 1000,
    };

    const resultPromise = cacheable.call(
        executeOptions,
        () =>
            new Promise((resolve) => {
                setTimeout(() => resolve('slow value'), 3 * 1000);
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
});

test('should process other calls in case the wait timeout happens on inflight error', async () => {
    const cacheable = new PromiseCacheable(defaultRedisFactory);
    const executeOptions = {
        ...defaultExecuteOptions,
        key: uuidv4(),
    };

    const resultPromise = cacheable.call(
        executeOptions,
        () =>
            new Promise((resolve, reject) => {
                setTimeout(() => reject('slow value'), 2 * 1000);
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
});

test('should respect the cache timeout', async () => {
    const cacheable = new PromiseCacheable(defaultRedisFactory);
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
});

test('should ignore cache if redis is out', async () => {
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

test('should support object values', async () => {
    const cacheable = new PromiseCacheable(defaultRedisFactory);

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

    //returned by redis cache
    expect(result2).toStrictEqual(processedValue);

    cacheable.close();
});
