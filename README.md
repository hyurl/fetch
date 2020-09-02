# Smart Fetch

**A web fetch tool that imitates browser behavior and suitable for crawlers.**

This package is based on [axios](https://github.com/axios/axios) and configured
in ready-in-use state, which solves some frequent problems that Node.js or axios
has internally.

### Main Features

#### Asynchronous DNS Lookup

Node.js internally uses
[dns.lookup](https://nodejs.org/dist/latest-v14.x/docs/api/dns.html#dns_dns_lookup)
to resolve IP addresses for hostnames, which is synchronous under the hood
(calls `getaddrinfo`), that means it will block the Node.js thread pool, giving
the program a huge disadvantage on performance when requests are too busy.

To solve this problem, this package use
[better-lookup](https://github.com/hyurl/better-lookup) to support DNS lookup,
which is asynchronous and supports TTL cache, to reduce DNS queries when
requesting web resources.

#### Full Proxy Support

If you're using a proxy in your program, there is a big chance that you're
gonna face an error that says *protocol not supported*, this happens when you're
requesting an HTTPS resource via an HTTP proxy, or other way around. The
internal proxy support provided by *axios* is very immature, which doesn't allow
you mixing the proxy protocol and the target url protocol.

To solve this issue, this package integrated with
[https-proxy-agent](https://github.com/TooTallNate/node-https-proxy-agent),
which gives you the full proxy ability like what you have in your browser.

#### Auto-detect Charset

Although designers tend to use UTF-8 as the default charset in modern websites,
there are still many websites that use other charset, the browser can
automatically detect them and display the web page almost perfectly even without
a proper charset header in response. However, in Node.js, it causes our own
effort to support that.

Luckily, by integrated with [jschardet](https://github.com/aadsm/jschardet),
**smart-fetch** is able to perform such functionality in our program, and is as
much good as the browser does.

#### Auto-retry Requests

In the browser, if you visit a link and it doesn't work, the browser will
automatically retry the request in a while (after a few seconds), this behavior
is very useful for a fetcher program, especially when you're designing a crawler
system, you'd hope that you can retry as many time as you could to get the
response.

So **smart-fetch** allows you doing that, no any magic, just a simple option,
and the program will automatically retry the request in a way of exponential
backoff.

#### Locale Language Support

Just like the browser, this package detects you locale settings, and deliver the
resource in your preferred language, so that to prevent any confusion of what
you see in your browser and what you're gonna get in the program.

#### Other Features

This package also comes with many other features, like set-cookie style cookies,
auto-capitalize header fields, reuse connection, auto-parse response, etc. all
is meant to perform more like a browser agent and more handy for use.

## Example

```ts
import fetch from "smart-fetch";

(async () => {
    let {
        ok,
        url,
        status,
        statusText,
        data
    } = await fetch("https://example.com/some/url");

    if (ok) {
        console.log(data);
    } else {
        if (status === 404) {
            console.log(`The requested URL ${url} is gone`);
        } else {
            console.log(`${status} ${statusText}`);
        }
    }
})();
```

## API

```ts
class Fetcher {
    constructor(private config?: FetcherConfig);

    /**
     * Dispatches the request, this method doesn't fetch the resource itself,
     * it is used for performing preparation on the request and manipulation on
     * the response, and relies on the `handle` function to fetch the resource.
     * 
     * This is an open interface, any function that fulfills the `handle`
     * signature can be used to fetch data and allow this method to build an
     * well-formed structure of the request and response.
     */
    static dispatch(
        request: Request,
        handle: (request: Request) => Promise<Response>,
        magicVars?: boolean
    ): Promise<Response>;

    /**
     * Fetches the web resource according the given URL and any other options.
     */
    fetch<T extends MessageType>(
        url: string,
        options?: Omit<Request, "url">
    ): Promise<Response<T>>;
    fetch<T extends MessageType>(request: Request): Promise<Response<T>>;
}
```

For relevant types and detailed usage explanations, please check
[the type definitions](./src/types.ts).

NOTE: the default function `fetch`, as used in the above example, is just a
short-hand of `new Fetcher().fetch()`, which uses a built-in fetcher instance
that turns [`magicVars`](./src/types.ts#L81) on.
