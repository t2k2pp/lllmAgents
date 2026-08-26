const REQUIRED_SECTIONS = ["背景:", "変更:", "検証:"];
const JAPANESE_TEXT = /[ぁ-んァ-ヶ一-龯]/u;

/**
 * Validate the repository's commit-message contract.
 *
 * A useful history entry must stand on its own: the subject says what intent
 * changed, while the body preserves the reason, implementation boundary, and
 * evidence available at commit time.
 */
export function validateCommitMessage(message) {
  const normalized = String(message).replace(/\r\n/g, "\n").trimEnd();
  const lines = normalized.split("\n");
  const subject = lines[0]?.trim() ?? "";
  const errors = [];

  if (!subject) {
    errors.push("タイトルがありません");
  } else if (!JAPANESE_TEXT.test(subject)) {
    errors.push("タイトルは変更目的が分かる日本語で記述してください");
  }

  if (lines[1] !== "") {
    errors.push("タイトルと本文の間に空行が必要です");
  }

  let previousIndex = 0;
  for (let index = 0; index < REQUIRED_SECTIONS.length; index++) {
    const heading = REQUIRED_SECTIONS[index];
    const headingIndex = lines.indexOf(heading);
    if (headingIndex < 0) {
      errors.push(`本文に「${heading}」が必要です`);
      continue;
    }
    if (headingIndex <= previousIndex) {
      errors.push(`「${heading}」の順序が正しくありません`);
    }
    const nextHeading = REQUIRED_SECTIONS[index + 1];
    const nextIndex = nextHeading ? lines.indexOf(nextHeading) : lines.length;
    const sectionLines = lines.slice(headingIndex + 1, nextIndex);
    if (!sectionLines.some((line) => /^\s*-\s+\S/u.test(line))) {
      errors.push(`「${heading}」に具体的な箇条書きが必要です`);
    }
    previousIndex = headingIndex;
  }

  return errors;
}
