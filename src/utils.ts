import { URL } from "url";
import { promisify } from "util";
import { AxiosProxyConfig } from "axios";
import { parseString, OptionsV2 } from "xml2js";
import timestamp from "@hyurl/utils/timestamp";
import pick = require("lodash/pick");
import moment = require("moment");
import { Headers, Request, Response } from "./types";

const parseStringAsync = promisify<any, OptionsV2, any>(<any>parseString);

export function lowerHeaders(headers: Headers) {
    let _headers: Headers = {};

    for (let field in headers) {
        _headers[field.toLowerCase()] = headers[field];
    }

    return _headers;
}

export function capitalizeHeaders(headers: Headers) {
    let _headers: Headers = {};
    let specials = {
        "accept-ch": "Accept-CH",
        "accept-ch-lifetime": "Accept-CH-Lifetime",
        "content-dpr": "Content-DPR",
        "content-md5": "Content-MD5",
        "content-sha1": "Content-SHA1",
        "dnt": "DNT",
        "dpr": "DPR",
        "etag": "ETAG",
        "expect-ct": "Expect-CT",
        "last-event-id": "Last-Event-ID",
        "nel": "NEL",
        "tcn": "TCN",
        "te": "TE",
        "tk": "TK",
        "www-authenticate": "WWW-Authenticate",
        "x-xss-protection": "X-XSS-Protection",
        "x-dns-prefetch-control": "X-DNS-Prefetch-Control",
        "x-ua-compatible": "X-UA-Compatible"
    };

    for (let field in headers) {
        let _field = specials[field] || field.split("-").map(
            part => part[0].toUpperCase() + part.slice(1).toLowerCase()
        ).join("-");

        _headers[_field] = headers[field];
    }

    return _headers;
}

export function constructProxy(proxy: string | AxiosProxyConfig) {
    if (typeof proxy === "string") {
        let urlObj = new URL(proxy);
        proxy = {
            protocol: urlObj.protocol,
            host: urlObj.hostname,
            port: Number(urlObj.port),
        };

        if (urlObj.username) {
            proxy.auth = pick(urlObj, ["username", "password"]);
        }
    } else {
        return proxy;
    }
}

export function parseXML(xml: string) {
    return parseStringAsync(xml, {
        // ignoreAttrs: true,
        async: true,
        explicitArray: false,
        explicitRoot: false
    });
}

export function resolveContentType(
    resHeaders: Response["headers"],
    reqHeaders: Request["headers"]
) {
    let contentType = <string>resHeaders["content-type"] || "";
    let acceptType = <string>getHeader(reqHeaders, "accept");

    acceptType && (acceptType = acceptType.split(/,\s*/)[0]);
    contentType || (contentType = acceptType || "text/plain; charset=UTF-8");

    return extractContentType(contentType);
}

export function fixResponse(res: Response, req: Request): Response {
    let acceptType: string;
    let isString = typeof res.data === "string";

    if (isString)
        res.data = String(res.data).trim();

    if (isString && (acceptType = getHeader(req.headers, "accept"))) {
        let { type } = extractContentType(acceptType.split(/,\s*/)[0]);

        if (type === "json") {
            try {
                res.data = JSON.parse(<string>res.data);
                res.type = "json";
            } catch (e) { }
        }
    }

    return res;
}

export function getHeader<T extends string | string[]>(
    headers: Record<string, string | string[]>,
    field: string
): T {
    field = field.toLowerCase();

    for (let name in headers) {
        if (name.toLowerCase() === field) {
            return headers[name] as T;
        }
    }
}

export function extractContentType(contentType: string): {
    type: string,
    prefix: string,
    charset?: string;
} {
    let segment = {
        type: "",
        prefix: "",
        charset: void 0
    };

    if (contentType) {
        let type = contentType.split("/");
        segment.prefix = type[0];

        if (type[1]) {
            let pair = type[1].split(";");
            segment.type = pair[0];

            if (pair[1]) {
                let charset = pair[1].split("=");
                segment.charset = charset[1];
            }
        }
    }

    return segment;
}

export function resolveMagicVars(url: string) {
    return url
        .replace(/\{ts\}/g, () => String(timestamp())) // Unix timestamp
        .replace(/\{ms\}/g, () => String(Date.now())) // timestamp in milliseconds
        .replace(/\{date\}/g, () => moment().format("YYYY-MM-DD")) // simple date string
        .replace(/\{date:(.+?)\}/g, (_, $1) => moment().format($1)) // custom date format
        .replace(/\{rand\}/g, () => String(Math.random())); // random number
}