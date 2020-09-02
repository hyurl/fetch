import fetch, { Fetcher, Request, Response } from "..";
import { App } from "webium";
import * as assert from "assert";
import * as http from "http";
import * as https from "https";
import * as fs from "fs";
import { sync as locale } from "os-locale";
import proxy = require("proxy");
import { isIPv4 } from "net";
import randStr from "@hyurl/utils/randStr";
import timestamp from "@hyurl/utils/timestamp";
import { URL } from "url";
import Axios from "axios";

const app = new App();
const proxyServer = proxy(http.createServer());

const osLang = locale();

app.get("/hello", () => {
    return "Hello, World!";
}).get("/test-magic-vars", (req) => {
    return { ts: Number(req.query["ts"]) };
}).get("/test-json", () => {
    return { foo: "Hello", bar: "World" };
}).get("/test-xml", (req, res) => {
    res.type = "application/xml";
    return { foo: "Hello", bar: "World" };
}).get("/test-binary", (req, res) => {
    return Buffer.from("Hello, World!");
}).get("/test-locale", (req, res) => {
    return { lang: req.lang };
}).get("/test-cookies", (req) => {
    return { cookies: req.cookies };
}).get("/reuse-connection", (req) => {
    return { keepAlive: req.headers["connection"] === "keep-alive" };
}).get("/test-retry", (req, res) => {
    if (Number(req.query["currentTS"]) - Number(req.query["originTS"]) >= 1) {
        return { ts: Number(req.query["currentTS"]) };
    } else {
        res.status = 425;
        res.end();
    }
});

before(async () => {
    await new Promise(resolve => app.listen(3000, resolve));
    await new Promise(resolve => proxyServer.listen(3128, resolve));
});

after(done => {
    app.close();
    done();
});

describe("new Fetcher()", () => {
    it("should create a Fetcher instance", async () => {
        let fetcher = new Fetcher();

        assert.deepStrictEqual(fetcher["config"], {
            magicVars: false,
            timeout: 30000
        });
        assert(fetcher["httpAgent"] instanceof http.Agent);
        assert(fetcher["httpsAgent"] instanceof https.Agent);
    });

    it("should create a Fetcher instance with magicVars turned on", async () => {
        let fetcher = new Fetcher({ magicVars: true });
        assert.deepStrictEqual(fetcher["config"], {
            magicVars: true,
            timeout: 30000
        });
    });
});

describe("new Fetcher().fetch()", () => {
    let fetcher = new Fetcher({ magicVars: true });

    it("should fetch response", async () => {
        let res = await fetcher.fetch("http://localhost:3000/hello");

        assert.strictEqual(res.type, "text");
        assert.strictEqual(res.data, "Hello, World!");
    });

    it("should reuse connection", async () => {
        let { headers, data } = await fetcher.fetch(
            "http://localhost:3000/reuse-connection"
        );

        assert.strictEqual(headers["connection"], "keep-alive");
        assert.deepStrictEqual(data, { keepAlive: true });
    });

    it("should use asynchronous DNS lookup", async () => {
        try {
            await fetcher.fetch(`http://${randStr(64)}.com`);
        } catch (err) {
            assert.strictEqual(err["syscall"], "queryA");
        }
    });

    it("should retry the request", async function () {
        this.timeout(5000);

        let ts = timestamp();
        let { data } = await fetcher.fetch<object>(
            `http://localhost:3000/test-retry?originTS=${ts}&currentTS={ts}`,
            { retries: 3 }
        );

        assert.strictEqual(data["ts"], timestamp());
    });

    it("should support cookies in two styles", async () => {
        let res = await fetcher.fetch("http://localhost:3000/test-cookies", {
            cookies: [
                "foo=abc",
                "bar=123; expires=Thu, 01-Oct-20 15:33:08 GMT; path=/; HttpOnly; SameSite=Lax"
            ]
        });

        assert.deepStrictEqual(
            res.data,
            { cookies: { foo: "abc", bar: "123" } }
        );
    });

    describe("Auto-detection", () => {
        it("should auto-detect response charset", async () => {
            let text = fs.readFileSync(__dirname + "/gb2312.txt");
            let server = http.createServer((req, res) => {
                res.setHeader("Content-Type", "text/html");
                res.end(text);
            });

            await new Promise(resolve => server.listen(30001, resolve));

            let res = await fetcher.fetch<string>("http://localhost:30001");

            assert.strictEqual(res.data, "你好，世界！");
            assert.strictEqual(res.headers["content-type"], "text/html");
            server.close();
        });

        it("should auto-detect locale language", async () => {
            let res = await fetcher.fetch("http://localhost:3000/test-locale");

            assert.deepStrictEqual(res.data, { lang: osLang });
        });
    });

    describe("Auto-parse Response", () => {
        it("should parse json", async () => {
            let res = await fetcher.fetch("http://localhost:3000/test-json");

            assert.strictEqual(res.type, "json");
            assert.deepStrictEqual(res.data, { foo: "Hello", bar: "World" });
        });

        it("should parse xml to json", async () => {
            let res = await fetcher.fetch("http://localhost:3000/test-xml");

            assert.strictEqual(res.type, "json");
            assert.deepStrictEqual(res.data, { foo: "Hello", bar: "World" });
        });

        it("should parse buffer", async () => {
            let res = await fetcher.fetch("http://localhost:3000/test-binary");

            assert.strictEqual(res.type, "buffer");
            assert.deepStrictEqual(res.data, Buffer.from("Hello, World!"));
        });
    });

    describe("Enforce-parse Response", () => {
        it("should enforce parsing text as buffer", async () => {
            let res = await fetcher.fetch("http://localhost:3000/hello", {
                responseType: "buffer"
            });

            assert.strictEqual(res.type, "buffer");
            assert.deepStrictEqual(res.data, Buffer.from("Hello, World!"));
        });

        it("should enforce parsing buffer as text", async () => {
            let res = await fetcher.fetch("http://localhost:3000/test-binary", {
                responseType: "text"
            });

            assert.strictEqual(res.type, "text");
            assert.deepStrictEqual(res.data, "Hello, World!");
        });
    });

    describe("Proxy Support", () => {
        it("should use HTTP proxy for HTTP resource", async () => {
            let res = await fetcher.fetch("http://localhost:3000/hello", {
                proxy: { host: "localhost", port: 3128 }
            });

            assert.strictEqual(res.data, "Hello, World!");
        });

        it("should use HTTP proxy for HTTPS resource", async function () {
            this.timeout(5000);

            let proxy1 = "127.0.0.1:3128";
            let { data } = await fetcher.fetch<string>("https://202020.ip138.com/", {
                headers: { referer: "https://www.ip138.com" },
                proxy: `http://${proxy1}`
            });
            let ip = data.match(/\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}/)?.[0];

            assert(isIPv4(ip));

            let proxy2 = "127.0.0.1:3228";
            try {
                await fetcher.fetch<string>("https://202020.ip138.com/", {
                    headers: { referer: "https://www.ip138.com" },
                    proxy: `http://${proxy2}`
                });
            } catch (err) {
                assert(String(err) === `Error: connect ECONNREFUSED ${proxy2}`);
            }
        });
    });

    describe("Magic Variables", () => {
        it("should support magic variables", async () => {
            let { data } = await fetcher.fetch(
                "http://localhost:3000/test-magic-vars?ts={ts}"
            );

            assert(typeof data === "object");
            assert(isFinite(data["ts"]));
        });

        it("should apply magic variables on referer field", async () => {
            try {
                await fetcher.fetch("http://localhost:3100/test-magic-vars?ts={ts}", {
                    headers: { referer: "http://localhost:3100?ts={ts}" }
                });
            } catch (err) {
                let urlObj = new URL(err["request"]["url"]);
                let ts = Number(urlObj.searchParams.get("ts"));

                assert.strictEqual(ts, timestamp());
            }
        });
    });
});

describe("Fetcher.dispatch()", () => {
    it("should dispatch a request via a custom handle function", async () => {
        let handle = async (request: Request) => {
            let res = await Axios.request(<any>request);
            let response: Response = {
                ok: res.status === 200,
                status: res.status,
                statusText: res.statusText,
                url: request.url,
                type: "text",
                data: res.data,
                headers: res.headers,
                cookies: []
            };

            return response;
        };
        let response = await Fetcher.dispatch({
            url: "http://localhost:3000/hello"
        }, handle);

        assert.deepStrictEqual(response, {
            ok: true,
            status: 200,
            statusText: "OK",
            url: "http://localhost:3000/hello",
            type: "text",
            data: "Hello, World!",
            headers: response.headers,
            cookies: []
        });
    });
});

describe("fetch()", () => {
    it("should fetch response", async () => {
        let res = await fetch("http://localhost:3000/hello");

        assert.strictEqual(res.type, "text");
        assert.strictEqual(res.data, "Hello, World!");
    });
});