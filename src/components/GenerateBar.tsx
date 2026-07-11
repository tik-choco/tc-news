// 選択済みアイテムから記事を生成するスティッキーバー。選択中アイテムのチップ列
// (トレイ)を上部に、件数表示・指示入力・生成ボタン列を下部に持つ。選択0件かつ
// 進行中でもエラーでもなければ何も表示しない(=描画すべきことがある時だけ出す)。
import type { JSX } from "preact";
import { Loader2, Network, Sparkles, X } from "lucide-preact";
import { useT } from "../lib/i18n";
import "../styles/generateBar.css";

export function GenerateBar(props: {
  /** 選択中のアイテム(表示順)。トレイのチップ列と件数表示の元。 */
  selectedItems: { id: string; title: string }[];
  instruction: string;
  onInstructionChange: (value: string) => void;
  /** 生成/編集部ジョブが実行中または待機中(ボタン・入力を無効化)。 */
  disabled: boolean;
  /** このビュー発の生成が進行中(プレビュー領域とボタンラベルの切替)。 */
  showProgress: boolean;
  /** 進行プレビューに出すテキスト(呼び出し側で解決済み)。 */
  progressText: string;
  error: string | null;
  onGenerate: () => void;
  onOrchestrate: () => void;
  /** トレイのチップの×: 該当アイテムを選択から外す。 */
  onRemoveSelected: (id: string) => void;
  /** 「選択解除」ボタン: 選択をすべて解除する。 */
  onClearSelection: () => void;
}): JSX.Element | null {
  const {
    selectedItems,
    instruction,
    onInstructionChange,
    disabled,
    showProgress,
    progressText,
    error,
    onGenerate,
    onOrchestrate,
    onRemoveSelected,
    onClearSelection,
  } = props;
  const t = useT();
  const selectedCount = selectedItems.length;

  if (selectedCount === 0 && !showProgress && !error) return null;

  return (
    <div class="feed-generate-bar">
      {selectedCount > 0 ? (
        <div class="feed-generate-tray" role="list" aria-label={t("feed.selectionTrayAria")}>
          {selectedItems.map((item) => {
            const title = item.title || t("feed.untitledItem");
            return (
              <span class="feed-generate-chip" role="listitem" key={item.id}>
                <span class="feed-generate-chip-title" title={title}>
                  {title}
                </span>
                <button
                  type="button"
                  class="feed-generate-chip-remove"
                  onClick={() => onRemoveSelected(item.id)}
                  disabled={disabled}
                  aria-label={t("feed.selectionRemoveAria", { title })}
                >
                  <X size={12} />
                </button>
              </span>
            );
          })}
          <button type="button" class="btn btn-ghost feed-generate-clear" onClick={onClearSelection} disabled={disabled}>
            {t("feed.inboxClearSelection")}
          </button>
        </div>
      ) : null}
      <div class="feed-generate-row">
        <span class="feed-generate-count">{t("feed.selectedCount", { count: selectedCount })}</span>
        <input
          class="feed-generate-instruction"
          value={instruction}
          placeholder={t("feed.instructionPlaceholder")}
          onInput={(e) => onInstructionChange(e.currentTarget.value)}
          disabled={disabled}
        />
        <button type="button" class="btn btn-primary" onClick={onGenerate} disabled={selectedCount === 0 || disabled}>
          <Sparkles size={15} />
          {showProgress ? t("feed.generating") : t("feed.generateArticle")}
        </button>
        <button
          type="button"
          class="btn btn-ghost"
          onClick={onOrchestrate}
          disabled={selectedCount === 0 || disabled}
          title={t("feed.orchestrateHint")}
        >
          <Network size={15} />
          {t("feed.orchestrateArticle")}
        </button>
      </div>
      {error ? <p class="feed-generate-error">{error}</p> : null}
      {showProgress ? (
        <div class="feed-generate-preview">
          <Loader2 size={14} class="spin" />
          <pre>{progressText}</pre>
        </div>
      ) : null}
    </div>
  );
}
