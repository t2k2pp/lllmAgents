/** Alternate Screenで端末へ依頼するマウスreport mode。 */
export const ENABLE_MOUSE_TRACKING = "\x1b[?1000h\x1b[?1006h";
export const DISABLE_MOUSE_TRACKING = "\x1b[?1006l\x1b[?1000l";

export type ScrollInputAction = {
  direction: "up" | "down";
  source: "page" | "wheel";
};

// PageUp/PageDown、SGR mouse、legacy X10 mouseを同じstdin streamから拾う。
// biome-ignore lint/suspicious/noControlCharactersInRegex: raw stdinのANSI CSI検出そのものが目的
const SCROLL_INPUT_PATTERN = /\x1b\[(?:(5|6)(?:;\d+)?~|<(\d+);\d+;\d+([Mm])|M([\s\S])([\s\S])([\s\S]))/g;
const INPUT_SEQUENCE_TAIL_CHARS = 64;
const MOUSE_MODIFIER_BITS = 4 | 8 | 16;

function mouseWheelDirection(buttonCode: number): "up" | "down" | undefined {
  const baseButton = buttonCode & ~MOUSE_MODIFIER_BITS;
  if (baseButton === 64) return "up";
  if (baseButton === 65) return "down";
  return undefined;
}

/** data chunk境界を跨ぐterminal scroll sequenceを重複なく復元する。 */
export class TerminalScrollInputParser {
  private tail = "";

  feed(chunk: Buffer | string): ScrollInputAction[] {
    // legacy X10 reportは座標を1 byteで運ぶため、BufferをUTF-8 decodeしない。
    const text = typeof chunk === "string" ? chunk : chunk.toString("latin1");
    const previousTailLength = this.tail.length;
    const combined = this.tail + text;
    const actions: ScrollInputAction[] = [];

    SCROLL_INPUT_PATTERN.lastIndex = 0;
    for (const match of combined.matchAll(SCROLL_INPUT_PATTERN)) {
      const end = (match.index ?? 0) + match[0].length;
      if (end <= previousTailLength) continue;

      if (match[1]) {
        actions.push({ direction: match[1] === "5" ? "up" : "down", source: "page" });
        continue;
      }

      if (match[2]) {
        // SGRの小文字mはbutton release。wheel操作はpressだけを1回処理する。
        if (match[3] !== "M") continue;
        const direction = mouseWheelDirection(Number(match[2]));
        if (direction) actions.push({ direction, source: "wheel" });
        continue;
      }

      const legacyButton = match[4]?.charCodeAt(0);
      if (legacyButton === undefined) continue;
      const direction = mouseWheelDirection(legacyButton - 32);
      if (direction) actions.push({ direction, source: "wheel" });
    }

    this.tail = combined.slice(-INPUT_SEQUENCE_TAIL_CHARS);
    return actions;
  }

  reset(): void {
    this.tail = "";
  }
}

/**
 * readlineはSGR mouse reportを1つのkeyとして扱わず、数字や末尾Mへ分割する。
 * ScreenManagerがscrollに使ったreportを入力欄へ混入させないためのfilter。
 */
export class MouseKeypressFilter {
  private inSgrReport = false;
  private legacyBytesRemaining = 0;

  shouldIgnore(sequence: string | undefined): boolean {
    if (!sequence) return false;

    if (this.legacyBytesRemaining > 0) {
      this.legacyBytesRemaining--;
      return true;
    }

    if (this.inSgrReport) {
      if (/[Mm]$/.test(sequence)) this.inSgrReport = false;
      return true;
    }

    if (sequence === "\x1b[M") {
      this.legacyBytesRemaining = 3;
      return true;
    }

    const sgrStart = sequence.indexOf("\x1b[<");
    if (sgrStart === -1) return false;
    this.inSgrReport = !/[Mm]$/.test(sequence.slice(sgrStart));
    return true;
  }
}
