import { LLM_CONFIG_KEY, emptyLlmConfig, loadLlmConfig, saveLlmConfig, subscribeLlmConfig } from "./llmConfig";
import type { SharedLlmConfigV1 } from "./llmConfig";

export type LlmConfigUpdateResult =
  | { ok: true; config: SharedLlmConfigV1 }
  | { ok: false; reason: "corrupted" | "write-failed"; config: SharedLlmConfigV1 };

/** 生キーは存在するのにloadLlmConfig()がnull = レコード破損。
 * この状態でsaveすると既存データを空configで丸ごと消すため、書き込み前のガードに使う。 */
export function isLlmConfigCorrupted(): boolean {
  try {
    const raw = localStorage.getItem(LLM_CONFIG_KEY);
    if (raw === null) return false;
    return loadLlmConfig() === null;
  } catch {
    // localStorage自体が使えない場合は「破損」ではなく単に読めないだけなので、
    // 呼び出し側の他のtry/catchに判断を委ねる。
    return false;
  }
}

/** saveLlmConfig()直後にstorageを読み戻し、実際にこの書き込みが反映された
 * かを検証する。safeSetItemはquota超過時にサイレントにfalseを返すだけで
 * saveLlmConfig()自体は何も返さないため、書き込み成否を検知するにはこの
 * verify-after-write以外に手段がない。比較はJSON文字列の完全一致で行う —
 * updatedAt(ミリ秒精度)の比較だと、直前の保存と同一ミリ秒内に走った失敗書き込み
 * が旧レコードのスタンプと偶然一致して成功扱いになる。 */
function wasWritePersisted(cfg: SharedLlmConfigV1): boolean {
  try {
    return localStorage.getItem(LLM_CONFIG_KEY) === JSON.stringify(cfg);
  } catch {
    return false;
  }
}

/** 常にstorageから最新のconfigを読み直してからmutateを適用して保存する
 * read-modify-write。破損レコード検出時は保存を拒否し {ok:false, reason:"corrupted"}。
 * 保存後にstorageを読み戻してupdatedAtを検証し、quota超過等で書き込みが
 * 破棄されていたら {ok:false, reason:"write-failed"}(safeSetItemはサイレントに
 * falseを返すため、vendoredなsaveLlmConfigを変えずに検知するにはverify-after-writeしかない)。
 * 成功時は同一タブの購読者(subscribeLlmConfigStore)へ同期通知する。 */
export function updateLlmConfig(mutate: (config: SharedLlmConfigV1) => void): LlmConfigUpdateResult {
  if (isLlmConfigCorrupted()) {
    return { ok: false, reason: "corrupted", config: emptyLlmConfig() };
  }

  const cfg = loadLlmConfig() ?? emptyLlmConfig();
  mutate(cfg);
  saveLlmConfig(cfg);

  if (!wasWritePersisted(cfg)) {
    return { ok: false, reason: "write-failed", config: cfg };
  }

  return { ok: true, config: cfg };
}

// Library notifications cover both same-tab settings/catalog saves and other tabs.
export function subscribeLlmConfigStore(cb: (config: SharedLlmConfigV1 | null) => void): () => void {
  return subscribeLlmConfig(cb);
}
