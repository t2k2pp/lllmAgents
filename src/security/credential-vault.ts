import { randomBytes, pbkdf2Sync, createCipheriv, createDecipheriv } from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const SALT_LENGTH = 32;
const IV_LENGTH = 16;
const AUTH_TAG_LENGTH = 16;
const KEY_LENGTH = 32;       // AES-256用: 256bit = 32byte
const ITERATIONS = 210_000;  // OWASP 2024推奨
const DIGEST = "sha512";
const ENCRYPTED_PREFIX = "encrypted:";

export class CredentialVault {

  /**
   * パスフレーズでAPIキーを暗号化する。
   * @returns "encrypted:<base64(salt + iv + authTag + ciphertext)>"
   */
  static encrypt(plaintext: string, passphrase: string): string {
    const salt = randomBytes(SALT_LENGTH);
    const key = pbkdf2Sync(passphrase, salt, ITERATIONS, KEY_LENGTH, DIGEST);
    const iv = randomBytes(IV_LENGTH);

    const cipher = createCipheriv(ALGORITHM, key, iv);
    const encrypted = Buffer.concat([
      cipher.update(plaintext, "utf8"),
      cipher.final(),
    ]);
    const authTag = cipher.getAuthTag();

    // salt(32) + iv(16) + authTag(16) + ciphertext(N)
    const combined = Buffer.concat([salt, iv, authTag, encrypted]);
    return `${ENCRYPTED_PREFIX}${combined.toString("base64")}`;
  }

  /**
   * パスフレーズで暗号化済みAPIキーを復号する。
   * 合言葉が間違っている場合、空文字を返す（API側で認証エラーにさせる）。
   */
  static decrypt(encryptedValue: string, passphrase: string): string {
    if (!encryptedValue.startsWith(ENCRYPTED_PREFIX)) {
      throw new Error("Not an encrypted value");
    }

    const combined = Buffer.from(
      encryptedValue.slice(ENCRYPTED_PREFIX.length),
      "base64",
    );

    const salt = combined.subarray(0, SALT_LENGTH);
    const iv = combined.subarray(SALT_LENGTH, SALT_LENGTH + IV_LENGTH);
    const authTag = combined.subarray(
      SALT_LENGTH + IV_LENGTH,
      SALT_LENGTH + IV_LENGTH + AUTH_TAG_LENGTH,
    );
    const ciphertext = combined.subarray(
      SALT_LENGTH + IV_LENGTH + AUTH_TAG_LENGTH,
    );

    const key = pbkdf2Sync(passphrase, salt, ITERATIONS, KEY_LENGTH, DIGEST);

    const decipher = createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(authTag);

    try {
      const decrypted = Buffer.concat([
        decipher.update(ciphertext),
        decipher.final(),
      ]);
      return decrypted.toString("utf8");
    } catch {
      // GCM認証タグ検証失敗 = 合言葉が間違っている
      // → 空文字を返し、API側で認証エラーにさせる
      return "";
    }
  }

  /** 値が暗号化済みかどうかを判定 */
  static isEncrypted(value: string): boolean {
    return value.startsWith(ENCRYPTED_PREFIX);
  }

  /** 値が環境変数参照かどうかを判定 */
  static isEnvReference(value: string): boolean {
    return value.startsWith("env:");
  }

  /**
   * APIキー値を解決する。優先度: 環境変数 > 暗号化 > 平文
   */
  static resolve(value: string, passphrase?: string): string {
    // 環境変数参照
    if (CredentialVault.isEnvReference(value)) {
      const envName = value.slice(4);
      return process.env[envName] ?? "";
    }

    // 暗号化済み
    if (CredentialVault.isEncrypted(value)) {
      if (!passphrase) return "";
      return CredentialVault.decrypt(value, passphrase);
    }

    // 平文（非推奨）
    return value;
  }
}
