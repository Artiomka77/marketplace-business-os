import {
  PLATFORM_JOBS_MODES,
  type PlatformJobsMode,
} from "./types";

export const PLATFORM_JOBS_MODE_ENV = "AVOROFIN_PLATFORM_JOBS_MODE";

export function resolvePlatformJobsMode(
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): PlatformJobsMode {
  const raw = String(env[PLATFORM_JOBS_MODE_ENV] ?? "")
    .trim()
    .toLowerCase();

  if (raw === PLATFORM_JOBS_MODES.SHADOW) {
    return PLATFORM_JOBS_MODES.SHADOW;
  }

  // Unknown / queue / "queue" / "live" fail closed to legacy.
  // Existing schedulers remain the only marketplace execution path.
  return PLATFORM_JOBS_MODES.LEGACY;
}

export function isLegacyDefaultMode(
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): boolean {
  return resolvePlatformJobsMode(env) === PLATFORM_JOBS_MODES.LEGACY;
}
