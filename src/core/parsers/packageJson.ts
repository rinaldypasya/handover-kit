import { tryRead } from "./fsUtil.js";

export interface PackageInfo {
  name?: string;
  description?: string;
  scripts: Record<string, string>;
  dependencies: string[];
}

export async function loadPackageInfo(repoRoot: string): Promise<PackageInfo | undefined> {
  const raw = await tryRead(repoRoot, "package.json");
  if (!raw) return undefined;
  try {
    const pkg = JSON.parse(raw);
    return {
      name: pkg.name,
      description: pkg.description,
      scripts: pkg.scripts ?? {},
      dependencies: Object.keys(pkg.dependencies ?? {}),
    };
  } catch {
    return undefined;
  }
}
