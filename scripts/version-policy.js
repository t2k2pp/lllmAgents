export const PUBLIC_VERSION_PATTERN = /^\d+\.\d+\.\d+$/;

export function validateVersionState({ packageVersion, lockVersion, lockRootVersion, changelog, releaseTag }) {
  const errors = [];
  if (!PUBLIC_VERSION_PATTERN.test(packageVersion)) {
    errors.push(`package.json version は MAJOR.MINOR.PATCH の3桁SemVerにしてください: ${packageVersion}`);
  }
  if (lockVersion !== packageVersion) {
    errors.push(`package-lock.json version (${lockVersion}) が package.json (${packageVersion}) と一致しません`);
  }
  if (lockRootVersion !== packageVersion) {
    errors.push(
      `package-lock.json packages[""].version (${lockRootVersion}) が package.json (${packageVersion}) と一致しません`,
    );
  }
  if (!changelog.includes(`## [${packageVersion}]`)) {
    errors.push(`CHANGELOG.md に ## [${packageVersion}] のリリース項目がありません`);
  }
  if (releaseTag && releaseTag !== `v${packageVersion}`) {
    errors.push(`release tag ${releaseTag} が package.json version v${packageVersion} と一致しません`);
  }
  return errors;
}
