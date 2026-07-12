export interface FeedSource {
  id: string;
  url: string;
  label: string;
  enabled: boolean;
  addedAt: number;
}

export interface FeedItem {
  id: string;          // linkの安定ハッシュ(または guid)
  feedId: string;
  feedLabel: string;
  title: string;
  link: string;
  summary: string;     // HTMLを除去したプレーンテキスト(最大500文字)
  publishedAt: number; // epoch ms
  fetchedAt: number;   // epoch ms
  imageUrl?: string;   // フィード内のメディア(media:*/enclosure/本文img)から抽出したサムネイル(絶対URL)
  videoUrl?: string;   // enclosure/media:content が直接の動画ファイルを指す場合のみ(絶対URL)
  category?: string;   // 自動分類の結果(lib/categories.ts の taxonomy。未分類はundefined)
}

export interface SourceLink {
  title: string;
  url: string;
}

export interface NewsArticle {
  id: string;
  title: string;
  excerpt: string;          // リード文(1〜2文)
  body: string;             // markdown本文
  tags: string[];
  sourceLinks: SourceLink[];
  authorDid: string;
  authorName: string;
  createdAt: number;        // epoch ms
  cid?: string;             // ルーム共有時に設定
  shared?: boolean;
  origin?: string;          // 受信記事を自分の記事として保存したときの取得元ルームID
  category?: string;        // 記事カテゴリー(lib/categories.ts の taxonomy。未分類はundefined)
  lang?: string;            // 生成時のUIロケール(lib/i18n の Locale値。未設定は言語不明として扱う)
  imageUrl?: string;        // ヒーロー画像(生成時にソースのFeedItem.imageUrlから引き継ぐ。絶対URL)
}

/** リアクションの固定taxonomy。ワイヤ(tc-news:reaction)に載るため変更禁止。 */
export const REACTION_KINDS = ["like", "fire", "clap", "laugh"] as const;
export type ReactionKind = (typeof REACTION_KINDS)[number];
export const REACTION_EMOJI: Record<ReactionKind, string> = {
  like: "👍",
  fire: "🔥",
  clap: "👏",
  laugh: "😂",
};

/** 番組(TTS読み上げ)の1セグメント。articleId は由来記事への参照(任意)。 */
export interface ProgramSegment {
  articleId?: string;
  text: string; // 読み上げる台本テキスト(プレーンテキスト)
  // {漢字|かんじ}記法(lib/ruby.ts)のマーカー入り台本。表示専用で、
  // TTS・音声レンダリングは text(プレーン)を使う。無ければルビなし表示。
  ruby?: string;
}

/** 記事群から生成したラジオ風番組。P2P共有時はJSON全体がCID化されて
 * tc-news:program ワイヤで配信される(記事と同じ方式。lib/newsWire.ts)。 */
export interface RadioProgram {
  id: string;
  title: string;
  segments: ProgramSegment[];
  createdAt: number;   // epoch ms
  lang?: string;       // 生成時のUIロケール(TTSの音声選択に使う)
  authorDid?: string;  // 共有時に付与(受信側は wire.fromId と一致検証する)
  authorName?: string; // 共有時に付与
  shared?: boolean;    // 自分の番組を共有済みか(ローカル表示用)
  // セグメントと同じ長さ・同順の音声CID(mistlib storage_add で格納)。
  // 共有時はJSONごとCID化されるので受信者はstorage_getで音声を取得できる。
  // 無ければ受信側TTSで読み上げ。
  audioCids?: string[];
  // audioCids のMIMEタイプ。TTSサーバーの実応答をsniffして決めるため
  // "audio/mpeg"(mp3)のことが多いが "audio/wav" のこともある(programAudio.ts参照)。
  audioMime?: string;
  audioVoice?: string; // レンダリングに使った声のID(表示用)
  imageUrl?: string;   // サムネイル(生成元記事のNewsArticle.imageUrlから引き継ぐ。絶対URL)
}

// LLM接続情報(provider)・モデル設定(preset)自体はもう tc-news 固有の型ではなく、
// 共有キー tc-shared-llm-config-v1 のスキーマ(lib/llmConfig.ts の LlmProviderV1 /
// ModelPresetV1 / VoiceConfigV1)で表現される。ProviderSettings(下記)は
// tc-news固有のローカル設定(lib/llmSettings.ts)のみを持つ。

export interface AppSettings {
  theme: "light" | "dark";
  userName: string;
  roomId: string;             // mistlib共有ルームID(既定 "tc-news")
  corsProxy: string;          // 例 "https://corsproxy.io/?url=" — encodeURIComponent(feedUrl) を後置
  refreshIntervalMin: number; // RSS自動更新間隔(分)、0で無効。既定30
  autoGenerate: boolean;      // 新着アイテムから記事を自動生成。既定 false
  globalShare: boolean;       // 共有時にグローバルルーム(tc-global-articles)へも配信。既定 true
  showMediaPreviews: boolean; // サムネイル/リンクプレビュー(OGP自動取得)を表示。既定 true
  programRuby: boolean;       // 番組台本の生成時に漢字等へルビ({漢字|かんじ}記法)を付ける。既定 false
}

export type MainTab = "feed" | "shared" | "program" | "settings";
