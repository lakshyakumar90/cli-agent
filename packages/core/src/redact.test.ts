import { describe, expect, it } from "vitest";
import { knownSecrets, redact, redactValue, REDACTED } from "./redact.js";

describe("taking the secrets out", () => {
  it("takes out a key of the usual shape", () => {
    const text = "the key is sk-abcdefghijklmnopqrstuvwxyz012345";

    expect(redact(text)).not.toContain("sk-abcdefghij");
    expect(redact(text)).toContain(REDACTED);
  });

  it("takes out a key the process knows", () => {
    const text = "the token is ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345";

    expect(redact(text)).toContain(REDACTED);
  });

  it("takes out the value the process holds", () => {
    const secret = "my-own-secret-value-1234";

    expect(redact(`the key is ${secret}`, { secrets: [secret] })).toBe(
      `the key is ${REDACTED}`,
    );
  });

  it("takes out a key that is written as a setting", () => {
    const text = 'api_key: "abc123def456ghi"';

    const redacted = redact(text);

    expect(redacted).not.toContain("abc123def456ghi");
    expect(redacted).toContain("api_key");
  });

  it("takes out a private key", () => {
    const text = [
      "-----BEGIN RSA PRIVATE KEY-----",
      "MIIEowIBAAKCAQEA",
      "-----END RSA PRIVATE KEY-----",
    ].join("\n");

    const redacted = redact(text);

    expect(redacted).not.toContain("MIIEowIBAAKCAQEA");
    expect(redacted).toContain(REDACTED);
  });

  it("takes out a bearer token", () => {
    const text = "Authorization: Bearer abcdefghijklmnopqrstuvwxyz";

    expect(redact(text)).not.toContain("abcdefghijklmnop");
  });

  it("leaves ordinary text alone", () => {
    const text = "the file src/index.ts exports a function called start()";

    expect(redact(text)).toBe(text);
  });

  it("leaves a short value alone", () => {
    // Too short to be a key, and redacting it would ruin the text.
    expect(redact("the port is 8080", { secrets: ["8080"] })).toBe(
      "the port is 8080",
    );
  });
});

describe("the secrets the process knows", () => {
  it("are the ones whose name says so", () => {
    const secrets = knownSecrets({
      OPENAI_API_KEY: "sk-abcdefghijklmnop",
      HOME: "/home/somebody",
      MY_TOKEN: "abcdefghijklmnop",
    });

    expect(secrets).toContain("sk-abcdefghijklmnop");
    expect(secrets).toContain("abcdefghijklmnop");
    expect(secrets).not.toContain("/home/somebody");
  });

  it("are the longest first", () => {
    const secrets = knownSecrets({
      A_KEY: "short",
      A_LONGER_KEY: "much-longer-value",
    });

    expect(secrets[0]).toBe("much-longer-value");
  });
});

describe("taking the secrets out of anything", () => {
  it("walks an object", () => {
    const value = redactValue({
      command: "curl -H 'Authorization: Bearer abcdefghijklmnopqrst'",
      nested: { key: "sk-abcdefghijklmnopqrst" },
      count: 3,
    });

    const text = JSON.stringify(value);

    expect(text).not.toContain("abcdefghijklmnopqrst");
    expect(text).not.toContain("sk-abcdefghijklmnopqrst");
    expect(text).toContain("3");
  });

  it("walks an array", () => {
    const value = redactValue(["sk-abcdefghijklmnopqrst", 42]);

    expect(JSON.stringify(value)).not.toContain("sk-abcdefghij");
    expect(JSON.stringify(value)).toContain("42");
  });

  it("leaves a number alone", () => {
    expect(redactValue(42)).toBe(42);
  });
});
