// 選択済みアイテムから記事を生成するスティッキーバー。選択0件かつ進行中でも
// エラーでもなければ何も表示しない(=描画すべきことがある時だけ出す)。
import type { JSX } from "preact";
import { Loader2, Network, Sparkles } from "lucide-preact";
import { useT } from "../lib/i18n";
import "../styles/generateBar.css";

export function GenerateBar(props: {
  selectedCount: number;
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
}): JSX.Element | null {
  const { selectedCount, instruction, onInstructionChange, disabled, showProgress, progressText, error, onGenerate, onOrchestrate } =
    props;
  const t = useT();

  if (selectedCount === 0 && !showProgress && !error) return null;

  return (
    <div class="feed-generate-bar">
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
