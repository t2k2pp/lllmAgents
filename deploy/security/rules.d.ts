export type PermissionLevel = "auto" | "ask" | "deny";
export interface SecurityRule {
    pattern: RegExp;
    action: "block" | "warn";
    message: string;
}
export declare const DANGEROUS_COMMAND_PATTERNS: SecurityRule[];
export declare function checkCommand(command: string): SecurityRule | null;
//# sourceMappingURL=rules.d.ts.map