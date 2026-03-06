import { describe, it, expect } from "vitest";
import { CredentialVault } from "../../src/security/credential-vault.js";

describe("CredentialVault", () => {
  describe("encrypt / decrypt", () => {
    it("正しい合言葉で元のテキストが復元できる", () => {
      const original = "sk-test-api-key-12345";
      const passphrase = "my-secret-passphrase";

      const encrypted = CredentialVault.encrypt(original, passphrase);
      const decrypted = CredentialVault.decrypt(encrypted, passphrase);

      expect(decrypted).toBe(original);
    });

    it("暗号化値は encrypted: プレフィックスで始まる", () => {
      const encrypted = CredentialVault.encrypt("test", "pass");
      expect(encrypted.startsWith("encrypted:")).toBe(true);
    });

    it("毎回異なる暗号文が生成される (ランダムsalt/iv)", () => {
      const encrypted1 = CredentialVault.encrypt("test", "pass");
      const encrypted2 = CredentialVault.encrypt("test", "pass");
      expect(encrypted1).not.toBe(encrypted2);
    });

    it("間違った合言葉では空文字が返る", () => {
      const encrypted = CredentialVault.encrypt("secret", "correct-pass");
      const decrypted = CredentialVault.decrypt(encrypted, "wrong-pass");
      expect(decrypted).toBe("");
    });

    it("encrypted: プレフィックスがない場合はエラーをスロー", () => {
      expect(() => CredentialVault.decrypt("plain-text", "pass")).toThrow(
        "Not an encrypted value",
      );
    });
  });

  describe("isEncrypted", () => {
    it("encrypted: プレフィックスの場合 true", () => {
      expect(CredentialVault.isEncrypted("encrypted:abc123")).toBe(true);
    });

    it("通常テキストの場合 false", () => {
      expect(CredentialVault.isEncrypted("sk-abc123")).toBe(false);
    });
  });

  describe("isEnvReference", () => {
    it("env: プレフィックスの場合 true", () => {
      expect(CredentialVault.isEnvReference("env:MY_API_KEY")).toBe(true);
    });

    it("通常テキストの場合 false", () => {
      expect(CredentialVault.isEnvReference("sk-abc123")).toBe(false);
    });
  });

  describe("resolve", () => {
    it("環境変数参照を解決する", () => {
      process.env.TEST_VAULT_KEY = "resolved-key";
      const result = CredentialVault.resolve("env:TEST_VAULT_KEY");
      expect(result).toBe("resolved-key");
      delete process.env.TEST_VAULT_KEY;
    });

    it("存在しない環境変数は空文字を返す", () => {
      const result = CredentialVault.resolve("env:NONEXISTENT_KEY_12345");
      expect(result).toBe("");
    });

    it("暗号化値をパスフレーズで解決する", () => {
      const encrypted = CredentialVault.encrypt("my-api-key", "pass");
      const result = CredentialVault.resolve(encrypted, "pass");
      expect(result).toBe("my-api-key");
    });

    it("暗号化値でパスフレーズなしの場合は空文字を返す", () => {
      const encrypted = CredentialVault.encrypt("my-api-key", "pass");
      const result = CredentialVault.resolve(encrypted);
      expect(result).toBe("");
    });

    it("平文はそのまま返す", () => {
      const result = CredentialVault.resolve("plain-api-key");
      expect(result).toBe("plain-api-key");
    });
  });
});
