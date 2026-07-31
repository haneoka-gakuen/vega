import type {
  VegaNarrativeInputProvider,
  VegaNarrativeInputRequest,
} from "../narrative/commands";
import type { VegaJsonValue } from "@haneoka/vega-protocol";

export interface VegaBrowserNarrativeInput {
  readonly provider: VegaNarrativeInputProvider;
  dispose(): void;
}

/**
 * Creates the accessible input surface used by browser and desktop builds.
 * A host supplied `narrativeInput` remains authoritative and bypasses this UI.
 */
export const createBrowserNarrativeInput = (
  root: HTMLElement,
  lifetimeSignal?: AbortSignal,
): VegaBrowserNarrativeInput => {
  let activeCancel: (() => void) | null = null;
  let disposed = false;
  let sequence = 0;

  const provider: VegaNarrativeInputProvider = (request) => {
    if (disposed) return Promise.reject(new ReferenceError("The Vega browser input surface is disposed"));
    if (activeCancel) return Promise.reject(new Error("Vega cannot display two narrative input requests at once"));
    if (request.signal?.aborted) return Promise.reject(abortReason(request.signal));
    if (lifetimeSignal?.aborted) return Promise.reject(abortReason(lifetimeSignal));

    return new Promise<VegaJsonValue | undefined>((resolve, reject) => {
      const document = root.ownerDocument;
      const previousFocus = document.activeElement;
      const overlay = document.createElement("div");
      overlay.className = "vega-narrative-input";
      overlay.setAttribute("role", "presentation");
      overlay.style.cssText =
        "position:absolute;inset:0;z-index:1000;display:grid;place-items:center;padding:16px;box-sizing:border-box;background:rgb(7 8 22 / 58%);pointer-events:auto;";

      const form = document.createElement("form");
      form.className = "vega-narrative-input__dialog";
      form.setAttribute("role", "dialog");
      form.setAttribute("aria-modal", "true");
      form.style.cssText =
        "display:grid;width:min(480px,calc(100% - 32px));gap:16px;padding:24px;box-sizing:border-box;border:1px solid rgb(218 241 255 / 38%);border-radius:12px;background:linear-gradient(145deg,rgb(29 25 52 / 98%),rgb(20 36 61 / 98%));box-shadow:0 20px 70px rgb(0 0 0 / 38%);color:#fff;font:500 15px/1.5 Inter,ui-sans-serif,system-ui,sans-serif;";
      const prompt = document.createElement("label");
      prompt.id = `vega-narrative-input-${++sequence}`;
      prompt.textContent = request.prompt || request.variable;
      prompt.htmlFor = `${prompt.id}-control`;
      prompt.style.cssText = "font-size:17px;font-weight:650;";
      form.setAttribute("aria-labelledby", prompt.id);

      const input = document.createElement("input");
      input.id = prompt.htmlFor;
      input.name = request.variable;
      input.type = request.inputType;
      input.maxLength = request.maximumLength;
      input.autocomplete = "off";
      input.value = defaultInputValue(request.defaultValue);
      input.style.cssText =
        "width:100%;min-height:44px;padding:9px 12px;box-sizing:border-box;border:1px solid rgb(218 241 255 / 35%);border-radius:6px;background:rgb(255 255 255 / 12%);color:#fff;font:inherit;outline:none;";

      const error = document.createElement("p");
      error.setAttribute("role", "alert");
      error.hidden = true;
      error.style.cssText = "margin:0;color:#ffd0d7;font-size:13px;";

      const actions = document.createElement("div");
      actions.style.cssText = "display:flex;justify-content:flex-end;gap:8px;";
      const cancel = document.createElement("button");
      cancel.type = "button";
      cancel.textContent = "Cancel";
      const submit = document.createElement("button");
      submit.type = "submit";
      submit.textContent = "OK";
      for (const button of [cancel, submit]) {
        button.style.cssText =
          "min-width:88px;min-height:40px;padding:7px 15px;border:1px solid rgb(218 241 255 / 30%);border-radius:20px;background:rgb(255 255 255 / 10%);color:#fff;font:inherit;cursor:pointer;";
      }
      submit.style.background = "linear-gradient(90deg,rgb(74 89 155),rgb(74 146 153))";
      actions.append(cancel, submit);
      form.append(prompt, input, error, actions);
      overlay.append(form);
      root.append(overlay);

      let settled = false;
      const finish = (value: VegaJsonValue | undefined, reason?: unknown): void => {
        if (settled) return;
        settled = true;
        cleanup();
        if (reason !== undefined) reject(reason);
        else resolve(value);
      };
      const onSubmit = (event: SubmitEvent): void => {
        event.preventDefault();
        const result = narrativeInputValue(input.value, request);
        if (result.ok) {
          finish(result.value);
          return;
        }
        error.hidden = false;
        error.textContent = result.message;
        input.setAttribute("aria-invalid", "true");
        input.focus();
      };
      const onCancel = (): void => finish(undefined);
      const onAbort = (signal: AbortSignal): void => finish(undefined, abortReason(signal));
      const onOverlayPointer = (event: Event): void => event.stopPropagation();
      const cleanup = (): void => {
        activeCancel = null;
        form.removeEventListener("submit", onSubmit);
        cancel.removeEventListener("click", onCancel);
        overlay.removeEventListener("click", onOverlayPointer);
        request.signal?.removeEventListener("abort", requestAbort);
        lifetimeSignal?.removeEventListener("abort", lifetimeAbort);
        overlay.remove();
        if (
          previousFocus &&
          "focus" in previousFocus &&
          typeof previousFocus.focus === "function" &&
          previousFocus.isConnected
        ) {
          previousFocus.focus();
        }
      };
      const requestAbort = (): void => onAbort(request.signal!);
      const lifetimeAbort = (): void => onAbort(lifetimeSignal!);
      activeCancel = onCancel;
      form.addEventListener("submit", onSubmit);
      cancel.addEventListener("click", onCancel);
      overlay.addEventListener("click", onOverlayPointer);
      request.signal?.addEventListener("abort", requestAbort, { once: true });
      lifetimeSignal?.addEventListener("abort", lifetimeAbort, { once: true });
      queueMicrotask(() => input.focus());
    });
  };

  return {
    provider,
    dispose() {
      if (disposed) return;
      disposed = true;
      activeCancel?.();
      activeCancel = null;
    },
  };
};

export const narrativeInputValue = (
  value: string,
  request: Pick<VegaNarrativeInputRequest, "inputType" | "maximumLength">,
): { readonly ok: true; readonly value: VegaJsonValue } | { readonly ok: false; readonly message: string } => {
  if (value.length > request.maximumLength) {
    return { ok: false, message: `Maximum length is ${request.maximumLength}.` };
  }
  if (request.inputType !== "number") return { ok: true, value };
  const number = Number(value);
  if (!value.trim() || !Number.isFinite(number)) {
    return { ok: false, message: "Enter a valid number." };
  }
  return { ok: true, value: number };
};

const defaultInputValue = (value: VegaJsonValue): string => {
  if (value === null) return "";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
};

const abortReason = (signal: AbortSignal): unknown =>
  signal.reason ?? new DOMException("Narrative input was aborted", "AbortError");
