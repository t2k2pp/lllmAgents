export interface SkillDefinition {
  name: string;
  description: string;
  trigger: string; // e.g., "/commit"
  content: string; // The full skill prompt/instructions
  filePath: string;
  builtIn: boolean;
  /** フォークモード: "fork" の場合、独立したSubAgentコンテキストで実行 */
  context?: "fork";
  /** context:fork 時に許可するツールリスト（未指定時は全ツール） */
  tools?: string[];
  /** true の場合は user が slash trigger を直接入力した時だけ実行できる。 */
  disableModelInvocation?: boolean;
  /**
   * 将来拡張用: スキルのグループタグ (例: ["design"], ["dev", "review"])。
   * SKILL.md の frontmatter で group: ... と書けるよう型として用意。
   * 現在の実装ではロードしない (= ステップ 2 で取り込む)。
   * docs/multi-tier-harness-roadmap.md §future 参照。
   */
  group?: string[];
}

export class SkillRegistry {
  private skills = new Map<string, SkillDefinition>();
  /**
   * Phase F (Skills ON/OFF): 全スキル一括 ON/OFF。
   * false なら list/get/getByPrefix は何も返さない (= スキル機能を「無いように」 振る舞う)。
   * ファイル削除はしない (= disabledSkills とのレイヤー分離: global は瞬間切替、 個別は持続)。
   */
  private globalEnabled = true;
  /** 個別 skill を runtime/config で skip する集合 (skill.name で識別) */
  private disabledSkillNames = new Set<string>();

  register(skill: SkillDefinition): void {
    this.skills.set(skill.name, skill);
    // Also register by trigger (without /)
    if (skill.trigger.startsWith("/")) {
      this.skills.set(skill.trigger.slice(1), skill);
    }
  }

  // === ON/OFF 制御 API ===
  setGlobalEnabled(enabled: boolean): void {
    this.globalEnabled = enabled;
  }
  isGlobalEnabled(): boolean {
    return this.globalEnabled;
  }
  /** 永続/runtime 双方の skip 指定 (config.disabledSkills + REPL toggle 両方が呼ぶ) */
  disableSkill(name: string): void {
    this.disabledSkillNames.add(name);
  }
  enableSkill(name: string): void {
    this.disabledSkillNames.delete(name);
  }
  /** name → 有効か (global と個別の AND) */
  isEnabled(name: string): boolean {
    return this.globalEnabled && !this.disabledSkillNames.has(name);
  }

  /** runtime 個別 disable 中のスキル name 一覧 (config 永続化用) */
  getRuntimeDisabledNames(): string[] {
    return [...this.disabledSkillNames];
  }

  /**
   * disabled も含めた全スキル一覧 (status 表示用)。
   * list() は有効分のみだが、 こちらは UI で「無効化中: X」 を出すため。
   */
  listAllWithStatus(): Array<SkillDefinition & { enabled: boolean; runtimeDisabled: boolean }> {
    const seen = new Set<string>();
    const result: Array<SkillDefinition & { enabled: boolean; runtimeDisabled: boolean }> = [];
    for (const skill of this.skills.values()) {
      if (seen.has(skill.name)) continue;
      seen.add(skill.name);
      result.push({
        ...skill,
        enabled: this.isEnabled(skill.name),
        runtimeDisabled: this.disabledSkillNames.has(skill.name),
      });
    }
    return result;
  }

  get(nameOrTrigger: string): SkillDefinition | undefined {
    if (!this.globalEnabled) return undefined;
    // Try exact match
    const direct = this.skills.get(nameOrTrigger);
    if (direct && !this.disabledSkillNames.has(direct.name)) return direct;

    // Try without leading /
    if (nameOrTrigger.startsWith("/")) {
      const trimmed = this.skills.get(nameOrTrigger.slice(1));
      if (trimmed && !this.disabledSkillNames.has(trimmed.name)) return trimmed;
    }

    return undefined;
  }

  getByPrefix(input: string): { skill: SkillDefinition; remainingArgs: string } | undefined {
    if (!this.globalEnabled) return undefined;
    let bestMatch: SkillDefinition | undefined = undefined;

    // skillsマップには name と trigger(スラッシュなし) が両方入っているため、
    // 重複を弾くために values() からユニークなskillを取り出して検査する
    const uniqueSkills = this.list();

    for (const skill of uniqueSkills) {
      // トリガー (例: /chunkbase) で前方一致するか確認
      if (input.startsWith(skill.trigger)) {
        if (!bestMatch || skill.trigger.length > bestMatch.trigger.length) {
          bestMatch = skill;
        }
      }
    }

    if (bestMatch) {
      const remainingArgs = input.slice(bestMatch.trigger.length).trim();
      return { skill: bestMatch, remainingArgs };
    }
    return undefined;
  }

  list(): SkillDefinition[] {
    if (!this.globalEnabled) return [];
    // Deduplicate (skills are stored by name and trigger)
    const seen = new Set<string>();
    const result: SkillDefinition[] = [];
    for (const skill of this.skills.values()) {
      if (seen.has(skill.name)) continue;
      seen.add(skill.name);
      if (this.disabledSkillNames.has(skill.name)) continue; // 個別 skip
      result.push(skill);
    }
    return result;
  }

  getNames(): string[] {
    return this.list().map((s) => s.name);
  }

  getTriggers(): string[] {
    return this.list().map((s) => s.trigger);
  }
}
