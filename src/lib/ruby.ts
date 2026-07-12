// ルビ(ふりがな)記法のパーサー。`{漢字|かんじ}` (`{base|reading}`) 形式の
// マーカーをトークン列やプレーンテキストへ変換する。このモジュールが
// アプリ全体で唯一のルビ記法の定義箇所であり、他のコードは正規表現を
// 直接書かずここを経由すること(programGenerate.ts での生成時の除去、
// 表示コンポーネントでのレンダリングなど)。
//
// 記法はネストしない。base/reading が空、または `{`,`}`,`|` の対応が
// 崩れている(閉じ忘れ等)場合は変換せずリテラルの平文として扱う —
// 壊れた入力(LLMの出力ゆれ等)で例外を投げないことを優先する。

export interface RubyToken {
  base: string;
  ruby?: string;
}

// {base|reading} 形式のマーカー。base/reading には `{`,`}`,`|` を含めない
// (ネストや誤対応を避けるため)。
const RUBY_MARKER_RE = /\{([^{}|]+)\|([^{}|]+)\}/g;

/** マーカー入りテキストをトークン列に分解する。マーカー外の平文は ruby なし
 * トークンとして返る。base/reading が空のマーカーは変換せずリテラル扱い。 */
export function parseRuby(marked: string): RubyToken[] {
  const tokens: RubyToken[] = [];
  let lastIndex = 0;

  RUBY_MARKER_RE.lastIndex = 0;
  for (let m = RUBY_MARKER_RE.exec(marked); m; m = RUBY_MARKER_RE.exec(marked)) {
    const [full, base, reading] = m;
    if (!base || !reading) continue; // 空base・空readingはリテラル扱い(マッチをスキップ)

    if (m.index > lastIndex) {
      tokens.push({ base: marked.slice(lastIndex, m.index) });
    }
    tokens.push({ base, ruby: reading });
    lastIndex = m.index + full.length;
  }

  if (lastIndex < marked.length) {
    tokens.push({ base: marked.slice(lastIndex) });
  }

  return tokens;
}

/** マーカーを base のみに置換したプレーンテキストを返す。 */
export function stripRuby(marked: string): string {
  return parseRuby(marked)
    .map((token) => token.base)
    .join("");
}
