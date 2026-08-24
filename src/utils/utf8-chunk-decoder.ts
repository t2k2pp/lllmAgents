import { StringDecoder } from "node:string_decoder";

/**
 * UTF-8 ストリームを文字境界を保ってデコードする。
 * Buffer#toString() をチャンクごとに呼ぶと、多バイト文字がチャンク境界を
 * 跨いだときに U+FFFD へ壊れるため、stdout/stderr ごとに1インスタンスを使う。
 */
export class Utf8ChunkDecoder {
  private readonly decoder = new StringDecoder("utf8");
  private ended = false;

  write(chunk: Buffer | string): string {
    if (this.ended) return "";
    return this.decoder.write(typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk);
  }

  end(): string {
    if (this.ended) return "";
    this.ended = true;
    return this.decoder.end();
  }
}
