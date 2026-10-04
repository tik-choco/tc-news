import { useEffect, useState } from "preact/hooks";
import { fetchModels } from "@tik-choco/mistai";
import { ModelPicker } from "@tik-choco/mistai/preact";
import { useT } from "../lib/i18n";

// The wizard uses a transient endpoint until Save; discovery never writes shared config.
export function ModelField({ value, baseUrl, apiKey, onChange }: {
  value: string; baseUrl: string; apiKey: string; onChange: (model: string) => void;
}) {
  const t = useT();
  const [models, setModels] = useState<string[]>([]);
  useEffect(() => {
    let cancelled = false;
    setModels([]);
    const timer = setTimeout(() => {
      if (baseUrl.trim()) void fetchModels({ baseUrl, apiKey }).then(ids => { if (!cancelled) setModels(ids); }).catch(() => {});
    }, 500);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [baseUrl, apiKey]);
  return <ModelPicker providers={[{ id: "draft", label: baseUrl, baseUrl, apiKey, models }]} value={value ? { providerId: "draft", model: value } : undefined} recent={[]} label={t("onboarding.modelLabel")} onChange={ref => onChange(ref?.model ?? "")} />;
}
