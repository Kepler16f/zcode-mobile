// 只被用来取状态码文案；真 HTTP 走 HttpClientPort → 原生网络栈（§3.3）。
export const STATUS_CODES = {
  100: "Continue", 200: "OK", 201: "Created", 204: "No Content", 301: "Moved Permanently",
  302: "Found", 304: "Not Modified", 400: "Bad Request", 401: "Unauthorized", 403: "Forbidden",
  404: "Not Found", 405: "Method Not Allowed", 408: "Request Timeout", 409: "Conflict",
  410: "Gone", 413: "Payload Too Large", 422: "Unprocessable Entity", 429: "Too Many Requests",
  500: "Internal Server Error", 502: "Bad Gateway", 503: "Service Unavailable", 504: "Gateway Timeout",
};
export const METHODS = ["GET", "POST", "PUT", "DELETE", "PATCH", "HEAD", "OPTIONS"];
export const createServer = () => { throw new Error("mobile-compat: 端侧不起 HTTP server"); };
export const get = () => { throw new Error("mobile-compat: 请用 HttpClientPort"); };
export const request = get;
