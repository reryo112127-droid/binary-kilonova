// Cloudflare Workers用 cross-fetch シム
// Workers にはネイティブ fetch があるので、それをそのまま再エクスポートする
export const fetch = globalThis.fetch.bind(globalThis);
export const Headers = globalThis.Headers;
export const Request = globalThis.Request;
export const Response = globalThis.Response;
export default fetch;
