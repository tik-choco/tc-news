// "List options from an OpenAI-compatible endpoint" hooks for the LLM/TTS
// settings screens. useFetchedOptions is the generic core (ported from
// tc-town's lib/models.ts, with error messages localized via the tc-news
// i18n layer instead of fixed Japanese); useModelOptions points it at
// {baseUrl}/models, and lib/voices.ts points it at the voices endpoints.
// Fetching is on-demand only: once when a field first mounts and again
// whenever the caller invokes `refresh()` (the refresh button). It never
// re-fetches on baseUrl/apiKey keystrokes, so typing doesn't thrash the
// endpoint.

import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import { fetchModels, formatMistaiError, MESSAGES_JA, MESSAGES_EN, type FetchFn } from "@tik-choco/mistai";
import { getLocale, tGlobal } from "./i18n";

export type ModelFetchStatus = "idle" | "loading" | "done" | "error";

export interface ModelOptionsState {
  /** Ids fetched from the endpoint (empty until a fetch succeeds). */
  options: string[];
  status: ModelFetchStatus;
  /** Localized message describing the last failure, set only when status is "error". */
  errorMessage: string;
  /** Re-fetches using the latest baseUrl/apiKey passed to the hook. */
  refresh: () => void;
}

export type OptionsFetcher = (
  config: { baseUrl: string; apiKey: string },
  fetchFn?: FetchFn,
) => Promise<string[]>;

/**
 * Generic version of {@link useModelOptions}: fetches a string list via
 * `fetcher({ baseUrl, apiKey })`. `baseUrl`/`apiKey` are read fresh on every
 * fetch (via a ref) but changing them does NOT by itself trigger a re-fetch —
 * call `refresh()` explicitly. `errorFallbackKey` is a tGlobal() catalog key
 * (e.g. "errors.modelListFailed"), resolved at failure time so the message
 * follows the locale active when the fetch actually ran.
 */
export function useFetchedOptions(
  baseUrl: string,
  apiKey: string,
  fetcher: OptionsFetcher,
  errorFallbackKey: string,
): ModelOptionsState {
  const [options, setOptions] = useState<string[]>([]);
  const [status, setStatus] = useState<ModelFetchStatus>("idle");
  const [errorMessage, setErrorMessage] = useState("");

  const configRef = useRef({ baseUrl, apiKey });
  configRef.current = { baseUrl, apiKey };

  const refresh = useCallback(() => {
    const { baseUrl, apiKey } = configRef.current;
    const trimmedBaseUrl = baseUrl.trim();
    if (!trimmedBaseUrl) {
      setOptions([]);
      setStatus("idle");
      setErrorMessage("");
      return;
    }

    setStatus("loading");
    setErrorMessage("");
    void fetcher({ baseUrl: trimmedBaseUrl, apiKey })
      .then((ids) => {
        setOptions([...new Set(ids)].sort((left, right) => left.localeCompare(right)));
        setStatus("done");
      })
      .catch((error: unknown) => {
        setOptions([]);
        setStatus("error");
        const messages = getLocale() === "ja" ? MESSAGES_JA : MESSAGES_EN;
        setErrorMessage(formatMistaiError(error, messages, tGlobal(errorFallbackKey)));
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fetcher, errorFallbackKey]);

  // Fetch once when the field mounts; further fetches only happen through
  // an explicit refresh() call (e.g. the refresh button).
  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return { options, status, errorMessage, refresh };
}

/**
 * Fetches the list of model ids from `{baseUrl}/models`. Thin wrapper around
 * {@link useFetchedOptions} for the LLM profile / TTS model fields.
 */
export function useModelOptions(baseUrl: string, apiKey: string): ModelOptionsState {
  return useFetchedOptions(baseUrl, apiKey, fetchModels, "errors.modelListFailed");
}
