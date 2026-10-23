import { describe, expect, it } from "vitest";
import { parseCurl, tokenize } from "../curl";

describe("curl parsing", () => {
  it("takes method, URL, headers, query and body", () => {
    const c = parseCurl(`curl -X POST 'http://10.0.0.9:8080/api/v1/stats?window=1h' -H 'Content-Type: application/json' -H "Accept: application/json" -d '{"query":"{ up }"}'`);
    expect(c).toMatchObject({ method: "POST", url: "http://10.0.0.9:8080/api/v1/stats", query: { window: "1h" }, body: '{"query":"{ up }"}', headers: { "Content-Type": "application/json", Accept: "application/json" }, secrets: [] });
  });

  it("moves a bearer token into a secret field and removes it from everything shown", () => {
    const token = "eyJhbGciOiJIUzI1NiJ9.FAKE-TEST-TOKEN-1234567890";
    const c = parseCurl(`curl -s https://home.lan/api/status \\\n  -H "Authorization: Bearer ${token}"`);
    expect(c.secrets).toEqual([{ key: "token", label: "Bearer token", hint: expect.any(String), auth: { as: "bearer" }, value: token }]);
    expect(JSON.stringify({ ...c, secrets: c.secrets.map((x) => ({ ...x, value: undefined })) })).not.toContain(token);
    expect(c.redacted).toContain("<secret: Bearer token>");
    expect(c.headers).toEqual({});
  });

  it("moves API key headers, query keys and basic credentials too", () => {
    const c = parseCurl(`curl -u admin:hunter2-pass 'http://x.lan/a?api_key=QK123456' -H 'X-API-Key: HK123456'`);
    expect(c.secrets.map((s) => [s.key, s.auth.as, s.value])).toEqual([["password", "basic", "hunter2-pass"], ["x_api_key", "header", "HK123456"], ["api_key", "query", "QK123456"]]);
    expect(c.basicUser).toBe("admin");
    expect(c.redacted).not.toMatch(/hunter2|QK123456|HK123456/);
  });

  it("uses GET by default and POST when data is given", () => {
    expect(parseCurl("curl http://a.lan/x").method).toBe("GET");
    expect(parseCurl("curl http://a.lan/x --data a=1").method).toBe("POST");
    expect(parseCurl("curl -G http://a.lan/x --data a=1")).toMatchObject({ method: "GET", query: { a: "1" } });
  });

  it("refuses write methods and non-curl input", () => {
    expect(() => parseCurl("curl -X DELETE http://a.lan/x")).toThrow(/only GET and POST/);
    expect(() => parseCurl("wget http://a.lan")).toThrow(/start with curl/);
    expect(() => parseCurl("curl -H 'x: y'")).toThrow(/No URL/);
  });

  it("tokenizes quotes and escapes", () => {
    expect(tokenize(`curl "a b" 'c d' e\\ f`)).toEqual(["curl", "a b", "c d", "e f"]);
  });

  it("marks -k as verify TLS off", () => {
    expect(parseCurl("curl -k https://pve.lan:8006/api2/json/version").verifyTls).toBe(false);
  });
});
