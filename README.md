# nodejs remote promise cacheable

A lightweight nodejs library that allows you to avoid duplicated processing (http calls, database, processing, etc) in a distributed environment. The library is based on Redis lock and pub/sub operations to work.

The library tries to bring the best of the distributed world: **high throughput** and **low latency**, while keeping all operations **highly resilient**.

The main objective here is to avoid **unnecessary** work process. To achieve good throughput, latency and high availability numbers, we had to compromise on consistency, so if something goes wrong, the flow will continue and the target will be processed. If you have hard consistency requirements in your business, this library is not for you.

## Using

### Installation

**yarn**

```.sh
yarn add @moraes/remote-promise-cacheable
```

**npm**

```.sh
npm install --save @moraes/remote-promise-cacheable
```

### Code

```.js
import Redis from 'ioredis';
import PromiseCacheable from '@moraes/remote-promise-cacheable';

const cacheable = new PromiseCacheable(() => new Redis());

const callOptions = {
    key: 'my-slow-process-identifier',
    cacheTimeout: 10 * 60 * 1000,
    waitTimeout: 10 * 1000,
};

//simple sync operation
const result = await cacheable.call(callOptions, () => {
    //my slow process
    return 'result value';
});

//a more real use case, using async operation
const result = await cacheable.call(callOptions, ()=> {
    return axios.get('https://google.com.br')
        .then(response => response.data);
});

//release redis connection
cacheable.close();
```

### Properties

For each call, the following properties must be used:

-   **key** - the process identifier
-   **cacheTimeout** - total time in ms that the result will be on cache
-   **waitTimeout** - total time in ms that will be waiting while another call is finishing

### Logging

For logging, you must configure a [winston](https://www.npmjs.com/package/winston) logger instance, example:

```.js
const cacheable = new PromiseCacheable(() => new Redis(), {
    logger: winston.createLogger({
        level: 'info',
        transports: [new winston.transports.Console()]
    })
});
```

## Best practices

### Redis timeout

Configure Redis timeout for a resilient communication, the value should be low to quickly recover from a problem, and high to support a spike. Remember: timeout can be both a remedy and a poison.

### Wait timeout

Configure this value to be something close to the processing time of the real operation, this will prevent you of waiting a long time before knowing there was a problem.
