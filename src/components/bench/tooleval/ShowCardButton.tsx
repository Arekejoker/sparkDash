import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { ToolEvalRun } from "../../../api/types";
import { ImageIcon } from "../../ui/icons";
import { buildToolEvalShareCard, shareCardFileName, type ShareCardModel } from "../../SparkPage/benchShareCard";
import { CardPreview } from "../../SparkPage/CardPreview";
import { canCopyImages, copyPngToClipboard, renderShareCardPng } from "../../SparkPage/shareImage";
import type { NormToolResult } from "./normalize";

interface ShowCardButtonProps {
  data: NormToolResult;
  run: ToolEvalRun;
  sparkName: string;
}

/**
 * "Show card": renders the run's results as a share image (the same canvas card
 * the decode, prefill and quality benchmarks make) and opens it in a window where
 * it can be copied to the clipboard or saved as a PNG.
 */
export function ShowCardButton({ data, run, sparkName }: ShowCardButtonProps) {
  const [state, setState] = useState<"idle" | "working" | "error">("idle");
  const [card, setCard] = useState<{ url: string; blob: Blob; model: ShareCardModel } | null>(null);
  const [copied, setCopied] = useState<"idle" | "ok" | "err">("idle");
  const timer = useRef<number | undefined>(undefined);
  const imageClipboard = canCopyImages();

  // The preview owns a blob URL; release it when it goes away.
  useEffect(
    () => () => {
      if (card) URL.revokeObjectURL(card.url);
    },
    [card]
  );
  useEffect(() => () => window.clearTimeout(timer.current), []);

  const close = useCallback(() => {
    setCard(null);
    setCopied("idle");
  }, []);

  // Escape closes the card, not whatever sits behind it.
  useEffect(() => {
    if (!card) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      close();
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [card, close]);

  const show = async () => {
    if (state === "working") return;
    setState("working");
    const model = buildToolEvalShareCard(data, run, { sparkName });
    const blob = await renderShareCardPng(model);
    if (!blob) {
      setState("error");
      return;
    }
    setState("idle");
    setCard({ url: URL.createObjectURL(blob), blob, model });
  };

  const download = () => {
    if (!card) return;
    const link = document.createElement("a");
    link.href = card.url;
    link.download = shareCardFileName(card.model, "tool-eval");
    document.body.appendChild(link);
    link.click();
    link.remove();
  };

  const copy = async () => {
    if (!card) return;
    try {
      await copyPngToClipboard(card.blob);
      setCopied("ok");
    } catch {
      setCopied("err");
    }
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setCopied("idle"), 1800);
  };

  return (
    <>
      <button
        type="button"
        className="btn btn--sm"
        onClick={() => void show()}
        disabled={state === "working"}
        title="Render these results as an image you can copy or save"
      >
        <ImageIcon className="h-3.5 w-3.5" />
        {state === "working" ? "Rendering…" : state === "error" ? "Could not render — retry" : "Show card"}
      </button>
      {card
        ? createPortal(
            <CardPreview
              url={card.url}
              label="Tool Eval share card"
              imgAlt={`Tool Eval Bench result card${data.score != null ? `: score ${data.score.toFixed(1)}` : ""}`}
              hint={
                imageClipboard ? (
                  <>Copy it to the clipboard or save it as a PNG. The card follows the dashboard's current theme.</>
                ) : (
                  <>
                    Right-click → <strong>Copy Image</strong>, or drag the card into your post. Browsers only let a page copy
                    images over HTTPS or localhost, so the card is shown here for your browser to copy.
                  </>
                )
              }
              onClose={close}
              onDownload={download}
              onCopy={imageClipboard ? () => void copy() : undefined}
              copyLabel={copied === "ok" ? "Copied!" : copied === "err" ? "Copy failed" : "Copy image"}
            />,
            document.body
          )
        : null}
    </>
  );
}
