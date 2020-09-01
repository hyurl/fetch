import { Fetcher } from "..";
import { App } from "webium";
import * as assert from "assert";
import * as http from "http";
import * as https from "https";
import * as fs from "fs";
import { sync as locale } from "os-locale";

const app = new App();
const osLang = locale();

app.get("/normal-res", () => {
    return "Hello, World!";
}).get("/test-query-time", (req) => {
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
});

before(done => {
    app.listen(3000, done);
});

after(done => {
    app.close();
    done();
});

describe("new Fetcher", () => {
    it("should create a Fetcher instance", async () => {
        let fetcher = new Fetcher();

        assert.deepStrictEqual(fetcher["config"], { magicVars: false, timeout: 30000 });
        assert(fetcher["httpAgent"] instanceof http.Agent);
        assert(fetcher["httpsAgent"] instanceof https.Agent);
    });

    it("should create a Fetcher instance with magicVars turned on", async () => {
        let fetcher = new Fetcher({ magicVars: true });
        assert.deepStrictEqual(fetcher["config"], { magicVars: true, timeout: 30000 });
    });
});

describe("Fetcher.fetch", () => {
    let fetcher = new Fetcher();

    it("should fetch response", async () => {
        let res = await fetcher.fetch<string>("http://localhost:3000/normal-res");

        assert.strictEqual(res.type, "text");
        assert.strictEqual(res.data, "Hello, World!");
    });

    it("should parse json", async () => {
        let res = await fetcher.fetch<object>("http://localhost:3000/test-json");

        assert.strictEqual(res.type, "json");
        assert.deepStrictEqual(res.data, { foo: "Hello", bar: "World" });
    });

    it("should parse xml to json", async () => {
        let res = await fetcher.fetch<object>("http://localhost:3000/test-xml");

        assert.strictEqual(res.type, "json");
        assert.deepStrictEqual(res.data, { foo: "Hello", bar: "World" });
    });

    it("should parse buffer", async () => {
        let res = await fetcher.fetch<Buffer>("http://localhost:3000/test-binary");

        assert.strictEqual(res.type, "buffer");
        assert.deepStrictEqual(res.data, Buffer.from("Hello, World!"));
    });

    it("should enforce parsing text as buffer", async () => {
        let res = await fetcher.fetch("http://localhost:3000/normal-res", {
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
        let res = await fetcher.fetch<object>("http://localhost:3000/test-locale");

        assert.deepStrictEqual(res.data, { lang: osLang });
    });

    it("should support cookies in two styles", async () => {
        let res = await fetcher.fetch<object>("http://localhost:3000/test-cookies", {
            cookies: [
                "foo=abc",
                "bar=123; expires=Thu, 01-Oct-20 15:33:08 GMT; path=/; HttpOnly; SameSite=Lax"
            ]
        });

        assert.deepStrictEqual(res.data, { cookies: { foo: "abc", bar: "123" } });
    });

    it("should support magicVars", async () => {
        let { data } = await fetcher.fetch<object>("http://localhost:3000/test-query-time?ts={ts}");

        assert(typeof data === "object");
        assert(isFinite(data["ts"]));
    });

    it("should reuse connection", async () => {
        let { headers, data } = await fetcher.fetch<object>("http://localhost:3000/reuse-connection");

        assert.strictEqual(headers["connection"], "keep-alive");
        assert.deepStrictEqual(data, { keepAlive: true });
    });
});