import Cookie from "sfn-cookie";
import Axios, { AxiosRequestConfig, AxiosResponse } from "axios";
import omitVoid from "@hyurl/utils/omitVoid";
import get = require("lodash/get");
import pick = require("lodash/pick");
import trimStart = require("lodash/trimStart");
import * as qs from "qs";
import * as http from "http";
import * as https from "https";
import * as iconv from "iconv-lite";
import { detect } from "jschardet";
import { detect as detectEA } from "jschardet-eastasia";
import { extname } from 'path';
import { lookup } from "mime-types";
import { sync as locale } from "os-locale";
import { exponential } from "backoff";
import { install } from "better-lookup";
import { Request, Response, MessageType, FetcherConfig } from "./types";
import {
    constructProxy,
    parseXML,
    resolveContentType,
    capitalizeHeaders,
    resolveMagicVars,
    lowerHeaders,
    extractContentType,
    fixResponse
} from "./utils";

export * from "./types";
export * as utils from "./utils";

const createProxyAgent = require("https-proxy-agent");

const sysLang = locale();
const UserAgent = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_3) "
    + "AppleWebKit/537.36 (KHTML, like Gecko) "
    + "Chrome/80.0.3987.116 "
    + "Safari/537.36";

const RetryableStatuses = [408, 409, 425, 500, 502, 503, 504];
const HangUpPattern = /net::ERR_EMPTY_RESPONSE|socket hang up/;
const UnretryablePattern = new RegExp([
    "ERR_CONNECTION_REFUSED", "ECONNREFUSED",
    "ERR_TOO_MANY_REDIRECTS", "Max redirects",
    "ERR_INTERNET_DISCONNECTED", "ENOTFOUND" // cannot resolve host or lost network
].join("|"), "i");

export class Fetcher {
    private httpAgent = install(new http.Agent({
        keepAlive: true,
        maxSockets: 10
    }), 4);
    private httpsAgent = install(new https.Agent({
        keepAlive: true,
        maxSockets: 10,
        rejectUnauthorized: false,
        minVersion: "TLSv1"
    }), 4);
    private proxyAgents: { [url: string]: any; } = {};

    constructor(private config: FetcherConfig = {}) {
        this.config = Object.assign({
            magicVars: false,
            timeout: 30000
        }, omitVoid(config));
    }

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
        magicVars = false
    ) {
        request = Object.assign(<Request>{
            method: "GET",
            headers: {},
            cookies: [],
            data: null,
            timeout: 30000,
            retries: 0
        }, omitVoid(request), {
            headers: lowerHeaders(request.headers || {})
        });

        if (request.data) {
            let patchQueryString = (query: string) => {
                request.data = null;

                if (request.url.includes("?")) {
                    request.url += "&" + query;
                } else {
                    request.url += "?" + query;
                }
            };

            if (typeof request.data === "object") {
                if (["GET", "HEAD", "get", "head"].includes(request.method)) {
                    // For GET/HEAD requests, encode the 'data' as the query
                    // string.
                    patchQueryString(qs.stringify(request.data));
                } else {
                    let { type } = extractContentType(
                        <string>request.headers["content-type"]
                    );

                    if (type === "x-www-form-urlencoded") {
                        request.data = qs.stringify(request.data, {
                            encodeValuesOnly: true
                        });
                    }
                }
            } else if (["GET", "HEAD", "get", "head"].includes(request.method)) {
                patchQueryString(trimStart(String(request.data), "?&"));
            }
        }

        return new Promise<Response>((resolve, reject) => {
            let url = request.url;
            let referer = request.headers?.referer as string;
            let doRequest = async (retries = -1) => {
                retries += 1;

                let error: Error;
                let response: Response;
                let shouldRetry = false;
                let isGone = false;

                // resolve magic variables
                if (magicVars) {
                    request.url = resolveMagicVars(url);

                    // apply magic variables on referer field
                    if (referer) {
                        request.headers.referer = resolveMagicVars(referer);
                    }
                }

                try {
                    response = await handle(request);
                } catch (err) {
                    error = err;
                }

                if (response) {
                    shouldRetry = !response.ok
                        && retries < request.retries
                        && RetryableStatuses.includes(response.status);
                } else if (HangUpPattern.test(String(error))) {
                    isGone = true;

                    // If the socket is hung up, we only need to retry once,
                    // for it's very unlikely that the remote server will be
                    // able to serve the page once again in short while.
                    // If a user actually needs to retry the request, he/she can
                    // do that manually after a few minutes or even a few hours.
                    shouldRetry = retries < 1;
                } else {
                    shouldRetry = retries < request.retries
                        && !UnretryablePattern.test(String(error));
                }

                if (shouldRetry) {
                    tick.backoff();
                } else {
                    tick.reset();

                    if (error) {
                        if (error["isAxiosError"]) {
                            // delete axios special error properties
                            delete error["code"];
                            delete error["config"];
                            delete error["isAxiosError"];
                            delete error["toJSON"];

                            if (isGone) {
                                error.message = "net::ERR_EMPTY_RESPONSE at "
                                    + request.url;
                            }
                        }

                        error["request"] = request;
                        error["response"] = response || null;

                        reject(error);
                    } else {
                        resolve(fixResponse(response, request));
                    }
                }
            };
            let tick = exponential({
                initialDelay: 1000,
                maxDelay: 5000
            }).on("ready", doRequest);

            doRequest();
        });
    }

    /**
     * Fetches the web resource according the given URL and any other options.
     */
    fetch<T extends MessageType>(
        url: string,
        options?: Omit<Request, "url">
    ): Promise<Response<T>>;
    fetch<T extends MessageType>(request: Request): Promise<Response<T>>;
    async fetch(target: string | Request, options?: Request): Promise<Response> {
        if (typeof target === "string") {
            options = Object.assign(options || {}, { url: target });
        } else {
            options = target;
        }

        options.timeout || (options.timeout = this.config.timeout);

        return Fetcher.dispatch(
            options,
            this.request.bind(this),
            this.config.magicVars
        );
    }

    private async request(request: Request) {
        let { url, headers, cookies } = request;
        let { protocol, pathname } = new URL(url);

        // These headers are copied from Chrome and is meant to make Axios acts
        // like Chrome.
        headers = Object.assign({
            "accept-encoding": "gzip, deflate",
            "accept-language": "en-US,en;q=0.9,zh-CN;q=0.8,zh;q=0.7",
            "cache-control": "no-cache",
            "connection": "keep-alive",
            "pragma": "no-cache",
            "user-agent": UserAgent
        }, omitVoid(headers || {}, true, true, true));

        if (protocol === "http:") {
            headers["upgrade-insecure-requests"] = "1";
        }

        if (cookies) {
            // Although at here the program deals with the cookies set in the
            // 'headers', it is recommended only set cookies via the 'cookies'
            // option, since when using **puppeteer** adapter, cookies set in
            // the headers will be ignored.
            if (!headers["cookie"]) {
                headers["cookie"] = this.makeRequestCookies(cookies);
            } else {
                headers["cookie"] += "; " + this.makeRequestCookies(cookies);
            }
        }

        if (!headers["accept"]) { // Auto-detect 'Accept' mime type
            let ext = pathname ? extname(pathname) : void 0;
            let mime: string = ext && lookup(ext) || void 0;

            if (mime) {
                headers["accept"] = `${mime},*/*;q=0.9`;
            } else {
                headers["accept"] = "*/*";
            }
        }

        if (!headers["accept-language"].includes(sysLang)) {
            headers["accept-language"] = `${sysLang};q=1,`
                + (headers["accept-language"]);
        }

        return this.makeRequest({ ...request, headers });
    }

    private async makeRequest(request: Request) {
        let options: AxiosRequestConfig = {
            responseType: "arraybuffer",
            httpAgent: this.httpAgent,
            httpsAgent: this.httpsAgent,
            maxRedirects: request.maxRedirects || 5,
            headers: capitalizeHeaders(request.headers),
            ...pick(request, [
                "method",
                "url",
                "data",
                "timeout"
            ])
        };
        let reqLang = <string>request.headers["accept-language"];
        let proxyUrl: string;

        if (request.proxy) {
            let proxy = constructProxy(request.proxy);
            proxyUrl = proxy.host + ":" + proxy.port;

            if (proxy.protocol === "https:") {
                proxyUrl = "https://" + proxyUrl;
            } else {
                proxyUrl = "http://" + proxyUrl;
            }

            if (!this.proxyAgents[proxyUrl]) {
                let proxyOptions: Record<string, any> = {
                    keepAlive: true,
                    maxSockets: 10,
                    rejectUnauthorized: false,
                    minVersion: "TLSv1",
                    ...pick(proxy, ["protocol", "host", "port"])
                };

                if (proxy.auth) {
                    let { username, password } = proxy.auth;
                    proxyOptions.auth = username + ":" + password;
                }

                this.proxyAgents[proxyUrl] = install(
                    createProxyAgent(proxyOptions) as any,
                    4
                );
            }

            options.httpAgent = options.httpsAgent = this.proxyAgents[proxyUrl];
        }

        let res: AxiosResponse<Buffer>;

        try {
            res = await Axios.request(options);
        } catch (err) {
            if (err["response"]) {
                res = err["response"];
            } else {
                throw err;
            }
        }

        let resInfo = resolveContentType(res.headers, request.headers);
        let url: string = get(res.request, "res.responseUrl", request.url);
        let type = request.responseType || resInfo.type;
        let charset = request.responseCharset || resInfo.charset || (() => {
            if (reqLang.includes("zh") ||
                reqLang.includes("jp") ||
                reqLang.includes("ko")
            ) {
                return detectEA(res.data).encoding as string;
            } else {
                return detect(res.data).encoding;
            }
        })();
        let data: any;

        if (url && proxyUrl && url.startsWith(proxyUrl + "/")) {
            url = url.slice(proxyUrl.length + 1);
        }

        if (type === "buffer" ||
            (type === "octet-stream" && !request.responseType)
        ) { // do not decode
            type = "buffer";
            data = res.data;
        } else if (request.responseType) { // decode to 'text' or 'json'
            try {
                if (res.data.byteLength === 0) {
                    type = "text";
                    data = "";
                } else if (charset) {
                    type = "text";
                    data = iconv.decode(res.data, charset); // buffer -> string
                } else {
                    throw new TypeError("Cannot decode the data as "
                        + request.responseType
                        + ", try again with the 'responseCharset' option");
                }
            } catch (e) {
                if (request.responseCharset) {
                    throw new TypeError("Cannot decode the data by charset "
                        + request.responseCharset);
                } else {
                    throw new TypeError("Cannot decode the data as "
                        + request.responseType);
                }
            }

            if (request.responseType === "json") {
                try {
                    type = "json";

                    if (resInfo.type === "xml") { // XML -> JSON
                        data = await parseXML(data);
                    } else {
                        data = JSON.parse(data);
                    }
                } catch (err) {
                    let text = String(data);
                    let _text = text.length > 32
                        ? text.slice(0, 29) + "..."
                        : text;
                    throw new TypeError(
                        "Cannot decode the data '" + _text + "' as JSON");
                }
            }
        } else { // auto-detect
            if (["text", "application", "*"].includes(resInfo.prefix)) {
                try {
                    if (res.data.byteLength === 0) {
                        type = "text";
                        data = "";
                    } else if (charset) {
                        data = iconv.decode(res.data, charset);

                        if (type === "json") {
                            data = JSON.parse(data);
                        } else if (type === "xml") { // XML -> JSON
                            type = "json";
                            data = await parseXML(data);
                        } else {
                            type = "text";
                            data = data;
                        }
                    } else {
                        type = "buffer";
                        data = res.data;
                    }
                } catch (e) {
                    type = "buffer";
                    data = res.data;
                }
            } else {
                type = "buffer";
                data = res.data;
            }
        }

        let response: Response = {
            ok: res.status >= 200 && res.status < 300 || res.status === 304,
            url,
            status: res.status,
            statusText: res.statusText,
            headers: res.headers || {},
            cookies: res.headers["set-cookie"] || [],
            type: <Response["type"]>type,
            data
        };

        return response;
    }

    private makeRequestCookies(cookies: string[]): string {
        return cookies.map(cookie => new Cookie(cookie))
            .map(({ name, value }) => name + "=" + value)
            .join("; ");
    }
}

const fetcher = new Fetcher({ magicVars: true });
const fetch: Fetcher["fetch"] = fetcher.fetch.bind(fetcher);

export default fetch;