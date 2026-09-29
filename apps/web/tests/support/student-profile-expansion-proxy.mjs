import http from "node:http";
import fs from "node:fs";

if (process.env.COURSES_PROFILE_EXPANSION_ISOLATED !== "1") {
  throw new Error("The student-profile proxy requires an isolated local center fixture.");
}

const log = process.env.COURSES_PROFILE_EXPANSION_QUERY_LOG;
const proxyPort = Number(process.env.COURSES_PROFILE_EXPANSION_PROXY_PORT);
const apiPort = Number(process.env.COURSES_PROFILE_EXPANSION_API_PORT);
const webPort = Number(process.env.COURSES_PROFILE_EXPANSION_WEB_PORT);
if (!log || ![proxyPort, apiPort, webPort].every(port => Number.isInteger(port) && port > 1024 && port < 65536)
  || new Set([proxyPort, apiPort, webPort]).size !== 3) {
  throw new Error("Set a query log and distinct local proxy, API, and web ports.");
}

http.createServer((request, response) => {
  const host = request.headers.host?.split(":")[0].toLowerCase();
  if (host !== "alpha.courses.test" && host !== "beta.courses.test") {
    response.writeHead(400).end("Unexpected center host");
    return;
  }
  const api = request.url.startsWith("/api/") || request.url.startsWith("/sanctum/");
  const upstream = http.request({
    hostname: "127.0.0.1", port: api ? apiPort : webPort, path: request.url,
    method: request.method, headers: { ...request.headers, host: request.headers.host },
  }, result => {
    response.writeHead(result.statusCode, result.headers);
    if (api && request.method === "GET" && request.url.startsWith("/api/v1/center/")) {
      const count = result.headers["x-courses-query-count"];
      const ms = result.headers["x-courses-sql-ms"];
      fs.appendFileSync(log, JSON.stringify({ path: request.url, host: request.headers.host,
        count: count === undefined ? null : Number(count), ms: ms === undefined ? null : Number(ms) }) + "\n");
    }
    result.pipe(response);
  });
  upstream.on("error", () => response.writeHead(502).end("Local service unavailable"));
  request.pipe(upstream);
}).listen(proxyPort, "127.0.0.1");
