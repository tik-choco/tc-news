// ほぼ同一のニュースを検出してグルーピングする(近似重複検出)。
// RSSは同じニュースを別ソース/別記事URLで再配信することが多く
// (例:「OpenAI、新モデル『GPT-5』を発表 - ITmedia」と
// 「OpenAI、新モデル「GPT-5」を発表(Impress Watch)」)、フィード上に
// ほぼ同一の記事が並んでユーザー体験を損なう。ここでは
// タイトルの単語分割をせず(日本語が主なため形態素解析は持ち込まない)、
// 文字bigramのJaccard類似度と正規化リンクの一致だけで近似重複を判定する。
//
// タイトル比較の前に「コアタイトル」を導出する:先頭の【速報】/[PR]等の
// タグと、末尾の媒体名らしきサフィックス(" - ITmedia"、"(Impress Watch)"
// など)を取り除いたもの。媒体名サフィックス付きの再配信は最頻出の重複
// パターンだが、サフィックス部分が食い違うためフルタイトル同士のbigram
// 類似度は0.85に届かない(実測~0.5)。剥がしてから比較しつつ、安全網と
// して剥がす前のフルタイトル同士も従来ルールで比較する — 剥がしは
// タイトル経路のマッチを広げることはあっても狭めることはない。
//
// グルーピングは貪欲・順序保存の1パス:各itemを既存グループの代表と
// 比較し、最初にマッチしたグループへ合流、なければ新規グループを作る。
// 入力は新しい順を想定し、各クラスタの最初の出現(=最新)が代表になる。
//
// 副作用なしの純粋関数のみ。ストレージ/DOM/外部依存は持たない。

import type { FeedItem } from "../types";

export type FeedItemGroup = { item: FeedItem; duplicates: FeedItem[] };

const TITLE_SIMILARITY_THRESHOLD = 0.85;
const MIN_LENGTH_FOR_SIMILARITY = 8;
// bigram件数がこの比率を超えて異なる場合、Jaccardは0.85に届き得ないので
// 計算をスキップする(パフォーマンスガード)。
const MAX_LENGTH_RATIO_DIFF = 0.3;

const TRACKING_PARAM_PREFIXES = ["utm_"];
const TRACKING_PARAM_EXACT = new Set(["fbclid"]);

/** リンクを比較用に正規化する:前後空白除去・末尾スラッシュ除去・トラッキング
 * クエリパラメータ(utm_*, fbclid)除去。パースできない場合は素朴なtrim+末尾
 * スラッシュ除去にフォールバックする。 */
function normalizeLink(link: string): string {
  const trimmed = link.trim();
  if (!trimmed) return "";
  try {
    const url = new URL(trimmed);
    const keptParams: [string, string][] = [];
    for (const [key, value] of url.searchParams.entries()) {
      const lowerKey = key.toLowerCase();
      if (TRACKING_PARAM_EXACT.has(lowerKey)) continue;
      if (TRACKING_PARAM_PREFIXES.some((p) => lowerKey.startsWith(p))) continue;
      keptParams.push([key, value]);
    }
    url.search = "";
    for (const [key, value] of keptParams) url.searchParams.append(key, value);
    let normalized = url.toString();
    if (normalized.endsWith("/") && !normalized.endsWith("://")) {
      normalized = normalized.slice(0, -1);
    }
    return normalized;
  } catch {
    return trimmed.replace(/\/+$/, "");
  }
}

/** タイトルを比較用に正規化する:NFKC正規化 → 小文字化 → 空白・約物・記号除去。 */
function normalizeTitle(title: string): string {
  return title
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\p{P}\p{S}\s]/gu, "");
}

// 先頭の【速報】/[PR]のような短いタグ(繰り返し可)。
const LEADING_TAG_RE = /^(【[^】]{1,12}】|\[[^\]]{1,12}\])\s*/;

// 末尾の媒体名サフィックスを導く区切り文字列。最後の出現位置で分割する。
const TRAILING_SEPARATORS = [" - ", " − ", " – ", " — ", " | ", "|", " / ", "(", "(", "【"];

// サフィックス(媒体名)として許容する最大長と、剥がした後に残すべき最小長(生文字数)。
const MAX_SUFFIX_LENGTH = 25;
const MIN_CORE_HEAD_LENGTH = 8;

/** 生タイトルから「コアタイトル」を導出する:先頭のタグを繰り返し剥がし、
 * 末尾の媒体名らしきサフィックスを1つだけ剥がす(閉じ括弧が無くても末尾まで
 * まとめて落とす)。剥がすと残りが短くなりすぎる場合は剥がさない。 */
function deriveCoreTitle(title: string): string {
  let core = title.trim();

  // 1) 先頭のブラケットタグ(【速報】, [PR] など)を繰り返し除去。
  for (let m = LEADING_TAG_RE.exec(core); m; m = LEADING_TAG_RE.exec(core)) {
    core = core.slice(m[0].length);
  }

  // 2) 末尾の媒体名サフィックスを1つだけ除去:最後に現れる区切りを探し、
  //    区切り以降が1〜25文字かつ区切り以前が8文字以上ならサフィックスとみなす。
  let lastIdx = -1;
  let sepLen = 0;
  for (const sep of TRAILING_SEPARATORS) {
    const idx = core.lastIndexOf(sep);
    if (idx > lastIdx) {
      lastIdx = idx;
      sepLen = sep.length;
    }
  }
  if (lastIdx >= 0) {
    const head = core.slice(0, lastIdx).trim();
    const tail = core.slice(lastIdx + sepLen).trim();
    if (head.length >= MIN_CORE_HEAD_LENGTH && tail.length >= 1 && tail.length <= MAX_SUFFIX_LENGTH) {
      core = head;
    }
  }

  return core;
}

/** 正規化済み文字列から文字bigramの集合を作る。長さ1以下は空集合になる。 */
function bigramSet(normalized: string): Set<string> {
  const set = new Set<string>();
  for (let i = 0; i < normalized.length - 1; i++) {
    set.add(normalized.slice(i, i + 2));
  }
  return set;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const gram of a) {
    if (b.has(gram)) intersection++;
  }
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

type NormalizedTitle = {
  normalized: string;
  bigrams: Set<string>;
};

/** タイトルの比較用フィンガープリント。core はサフィックス/タグ除去後、
 * full は除去前の従来正規化(安全網)。両方とも代表側で1回だけ前計算する。 */
type TitleFingerprint = {
  core: NormalizedTitle;
  full: NormalizedTitle;
};

function normalizedFingerprint(text: string): NormalizedTitle {
  const normalized = normalizeTitle(text);
  return { normalized, bigrams: bigramSet(normalized) };
}

function fingerprintTitle(title: string): TitleFingerprint {
  const core = deriveCoreTitle(title);
  const full = normalizedFingerprint(title);
  // コア導出で何も剥がれなかった場合は同じ正規化結果になるので再計算しない。
  const coreFp = core === title.trim() ? full : normalizedFingerprint(core);
  return { core: coreFp, full };
}

function normalizedTitlesMatch(a: NormalizedTitle, b: NormalizedTitle): boolean {
  if (a.normalized.length === 0 || b.normalized.length === 0) return false;

  if (a.normalized.length < MIN_LENGTH_FOR_SIMILARITY || b.normalized.length < MIN_LENGTH_FOR_SIMILARITY) {
    return a.normalized === b.normalized;
  }

  const longer = Math.max(a.normalized.length, b.normalized.length);
  const shorter = Math.min(a.normalized.length, b.normalized.length);
  if ((longer - shorter) / longer > MAX_LENGTH_RATIO_DIFF) return false;

  return jaccard(a.bigrams, b.bigrams) >= TITLE_SIMILARITY_THRESHOLD;
}

/** コアタイトル同士で比較し、剥がしすぎ等に備えてフルタイトル同士でも比較する
 * (OR)。剥がしがマッチを狭める方向に働くことは無い。 */
function titlesMatch(a: TitleFingerprint, b: TitleFingerprint): boolean {
  if (normalizedTitlesMatch(a.core, b.core)) return true;
  // core と full が同一ならもう一度比べても結果は同じなのでスキップ。
  if (a.core === a.full && b.core === b.full) return false;
  return normalizedTitlesMatch(a.full, b.full);
}

type Representative = {
  group: FeedItemGroup;
  normalizedLink: string;
  title: TitleFingerprint;
};

/** 新しい順のitemsを近似重複でグルーピングする。順序は保存され、各クラスタの
 * 最初の出現(=最新)が代表 `item`、残りが `duplicates` になる。 */
export function groupNearDuplicateItems(items: FeedItem[]): FeedItemGroup[] {
  const representatives: Representative[] = [];

  for (const item of items) {
    const normalizedLink = normalizeLink(item.link);
    const title = fingerprintTitle(item.title);

    const match = representatives.find((rep) => {
      if (normalizedLink !== "" && normalizedLink === rep.normalizedLink) return true;
      return titlesMatch(title, rep.title);
    });

    if (match) {
      match.group.duplicates.push(item);
    } else {
      representatives.push({
        group: { item, duplicates: [] },
        normalizedLink,
        title,
      });
    }
  }

  return representatives.map((rep) => rep.group);
}
