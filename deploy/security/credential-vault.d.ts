export declare class CredentialVault {
    /**
     * パスフレーズでAPIキーを暗号化する。
     * @returns "encrypted:<base64(salt + iv + authTag + ciphertext)>"
     */
    static encrypt(plaintext: string, passphrase: string): string;
    /**
     * パスフレーズで暗号化済みAPIキーを復号する。
     * 合言葉が間違っている場合、空文字を返す（API側で認証エラーにさせる）。
     */
    static decrypt(encryptedValue: string, passphrase: string): string;
    /** 値が暗号化済みかどうかを判定 */
    static isEncrypted(value: string): boolean;
    /** 値が環境変数参照かどうかを判定 */
    static isEnvReference(value: string): boolean;
    /**
     * APIキー値を解決する。優先度: 環境変数 > 暗号化 > 平文
     */
    static resolve(value: string, passphrase?: string): string;
}
//# sourceMappingURL=credential-vault.d.ts.map