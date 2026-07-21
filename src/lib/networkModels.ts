// Helpers for AI Networkへ「共有するモデル」を扱うための小さなユーティリティ群。
// tc-translateのsrc/lib/networkModels.tsを移植したもの(参照実装は
// SettingsView.tsx冒頭コメント参照)。mist-network://疑似プロバイダは、ルーム
// 側が公開しているモデルをローカルのtc-shared-llm-config-v1へ取り込む際の
// provider baseUrlとして使われる(hooks/useNetworkModelSync.ts)。
export const NETWORK_PROVIDER_LABEL = "AI Network";
export const NETWORK_PROVIDER_URL_PREFIX = "mist-network://";

/** ルームIDから、そのルームを表す疑似プロバイダのbaseUrlを組み立てる。 */
export function networkProviderBaseUrl(roomId: string): string {
  return `${NETWORK_PROVIDER_URL_PREFIX}${roomId.trim() || "default"}`;
}

export function isNetworkProviderBaseUrl(baseUrl: string): boolean {
  return baseUrl.trim().startsWith(NETWORK_PROVIDER_URL_PREFIX);
}

/**
 * 共有するpresetが`provider_hello.models`で名乗る名前、かつ着信したモデル
 * 指定リクエストをどのpresetへ振り分けるかのキー: presetのlabel、空なら
 * modelにフォールバックする。この文字列は上流のモデルIDそのものではなく
 * 「表示名 = ルーティングキー」という room 単位の取り決め(tc-translateと
 * 共通)— 相手はこの文字列をそのまま送り返してくるだけで、実際にどのpresetに
 * 対応するかは広告した側だけが知っていればよい。
 */
export function advertisedModelName(target: { label: string; model: string }): string {
  return target.label.trim() || target.model;
}
