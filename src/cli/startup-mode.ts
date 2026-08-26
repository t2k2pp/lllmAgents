export interface CustomizationPolicy {
  plugins: boolean;
  skills: boolean;
  hooks: boolean;
  mcp: boolean;
  projectInstructions: boolean;
  memory: boolean;
  customAgents: boolean;
  customRules: boolean;
}

export interface StartupMode {
  safeMode: boolean;
  customizations: CustomizationPolicy;
}

/**
 * Resolve transient startup behavior from CLI arguments.
 *
 * Keep this list centralized: a recovery mode that accidentally leaves one
 * customization surface active cannot reliably diagnose a broken setup.
 */
export function resolveStartupMode(args: string[]): StartupMode {
  const safeMode = args.includes("--safe-mode");
  const enabled = !safeMode;
  return {
    safeMode,
    customizations: {
      plugins: enabled,
      skills: enabled,
      hooks: enabled,
      mcp: enabled,
      projectInstructions: enabled,
      memory: enabled,
      customAgents: enabled,
      customRules: enabled,
    },
  };
}
