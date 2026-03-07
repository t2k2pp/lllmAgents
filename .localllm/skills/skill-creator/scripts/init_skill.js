// init_skill.js
import * as fs from "node:fs";
import * as path from "node:path";

function main() {
  const skillName = process.argv[2];
  if (!skillName || !/^[a-z0-9-]+$/.test(skillName)) {
    console.error("エラー: 無効なスキル名です。小文字の英数字とハイフンのみを使用してください。");
    console.error("使用例: node init_skill.js my-new-skill");
    process.exit(1);
  }

  const baseDir = path.join(process.cwd(), ".localllm", "skills", skillName);

  if (fs.existsSync(baseDir)) {
    console.error(`エラー: スキルディレクトリが既に存在します: ${baseDir}`);
    process.exit(1);
  }

  const dirs = [
    baseDir,
    path.join(baseDir, "scripts"),
    path.join(baseDir, "references"),
    path.join(baseDir, "assets"),
  ];

  for (const dir of dirs) {
    fs.mkdirSync(dir, { recursive: true });
    console.log(`Created: ${dir}`);
  }

  const skillMdContent = `---
name: ${skillName}
description: [このスキルがいつ、何のために使われるかの詳細かつ簡潔な説明を記載してください。LLMがトリガーする際の判断材料になります。]
trigger: /${skillName}
---

# ${skillName}

## 概要
このスキルが何を行うかを記述します。

## 実行手順
ここには、LLMが迷わず実行できる「Low freedom」な手順を記述してください。
1. 引数から情報を取得する
2. \`scripts/main.js\` などの決定論的なスクリプトを起動する
3. ユーザーに結果をパースして報告する
`;

  const skillMdPath = path.join(baseDir, "SKILL.md");
  fs.writeFileSync(skillMdPath, skillMdContent, "utf-8");
  console.log(`Created: ${skillMdPath}`);

  console.log(`\n初期化が完了しました。${skillMdPath} と scripts/ などを要件に合わせて編集してください。`);
}

main();
