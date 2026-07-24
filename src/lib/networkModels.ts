// Helpers for AI Networkへ「共有するモデル」を扱うための小さなユーティリティ群。
// tc-translateのsrc/lib/networkModels.tsを移植したもの(参照実装は
// SettingsView.tsx冒頭コメント参照)。mist-network://疑似プロバイダは、ルーム
// 側が公開しているモデルをローカルのtc-shared-llm-config-v1へ取り込む際の
// provider baseUrlとして使われる(hooks/useNetworkModelSync.ts)。
import type { SharedLlmConfigV1 } from "./llmConfig";

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

/**
 * `config.defaultPresetId`の再割り当て候補として安全なpresetを選ぶ:
 * `mist-network://`疑似プロバイダ配下(このルームのものに限らず、他アプリ/他
 * ルームが残した分も含む)にぶら下がっていない最初のpreset。無ければ ""(未
 * 設定)を返す — `config.presets[0]`をそのまま採用しない。
 *
 * `tc-shared-llm-config-v1`はオリジン共有なので、既定presetが失効した際に
 * 単純に配列先頭を新しい既定へ昇格させると、その先頭がたまたま(このルーム
 * 自身がミラーしたものであれ、別アプリ/別ルームが残したものであれ)AI
 * Network経由のpresetだった場合、providerId未指定のタスク(TTS/STTなど。
 * resolvePreset経由でdefaultPresetIdにフォールバックする)がユーザーの意図
 * しないネットワーク経由へ無言で切り替わってしまう。tc-lingoの
 * `safeDefaultPresetFallback`(hooks/useNetworkModelSync.ts)と同じ方針。
 */
export function safeDefaultPresetFallback(config: SharedLlmConfigV1): string {
  const nonNetwork = config.presets.find((p) => {
    const provider = config.providers.find((pr) => pr.id === p.providerId);
    return provider !== undefined && !isNetworkProviderBaseUrl(provider.baseUrl);
  });
  return nonNetwork?.id ?? "";
}
