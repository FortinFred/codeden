import { describe, expect, it } from "vitest";
import { validateForgejoBaseUrl } from "../src/services/forge/forgejo/base-url";

describe("Forgejo base URL validation", () => {
  it("normalizes a local plain-HTTP base and derives /api/v1", () => {
    expect(validateForgejoBaseUrl("http://localhost:3000/")).toMatchObject({
      baseUrl: "http://localhost:3000",
      origin: "http://localhost:3000",
      apiUrl: "http://localhost:3000/api/v1/",
      host: "localhost:3000",
      insecureHttp: true,
    });
    expect(validateForgejoBaseUrl("http://127.0.0.1:3000/sub/")).toMatchObject({
      baseUrl: "http://127.0.0.1:3000/sub",
      apiUrl: "http://127.0.0.1:3000/sub/api/v1/",
    });
    expect(validateForgejoBaseUrl("http://[::1]:3000")).toMatchObject({
      baseUrl: "http://[::1]:3000",
      apiUrl: "http://[::1]:3000/api/v1/",
    });
    expect(validateForgejoBaseUrl("http://192.168.1.5:3000")).toMatchObject({
      insecureHttp: true,
    });
  });

  it("accepts HTTPS on any host", () => {
    expect(validateForgejoBaseUrl("https://forge.example.com:8443/")).toMatchObject({
      baseUrl: "https://forge.example.com:8443",
      apiUrl: "https://forge.example.com:8443/api/v1/",
      insecureHttp: false,
    });
  });

  it("refuses plain HTTP to a public host unless explicitly allowed", () => {
    expect(() => validateForgejoBaseUrl("http://forge.example.com")).toThrowError(/plain HTTP/);
    expect(() => validateForgejoBaseUrl("http://8.8.8.8")).toThrowError(/plain HTTP/);
    expect(
      validateForgejoBaseUrl("http://forge.example.com", { allowInsecureHttp: true }),
    ).toMatchObject({ baseUrl: "http://forge.example.com", insecureHttp: true });
  });

  it("refuses credentials, a query, a fragment or a non-HTTP scheme", () => {
    for (const url of [
      "https://user:pass@forge.example.com",
      "https://forge.example.com?x=1",
      "https://forge.example.com#top",
      "ftp://forge.example.com",
      "not a url",
    ]) {
      expect(() => validateForgejoBaseUrl(url), url).toThrowError(/Forgejo base URL/);
    }
  });
});
