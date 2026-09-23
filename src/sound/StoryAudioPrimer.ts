import { Howler } from "howler";

interface UnlockableAudioElement extends HTMLAudioElement {
  _unlocked?: boolean;
}

interface UnlockableHowl {
  _getSoundIds?(): number[];
  _soundById?(id: number): { _node?: UnlockableAudioElement } | null;
  _emit?(event: string): void;
  _webAudio?: boolean;
}

interface UnlockableHowler {
  _audioUnlocked?: boolean;
  _html5AudioPool?: UnlockableAudioElement[];
  _howls?: UnlockableHowl[];
  _releaseHtml5Audio?(audio: UnlockableAudioElement): void;
  _unlockAudio?(): void;
  ctx?: AudioContext | null;
  html5PoolSize?: number;
}

let immediateUnlockPending = false;
let fallbackUnlockArmed = false;
let trustedGesturePrepared = false;

const unlockableHowler = (): UnlockableHowler => Howler as unknown as UnlockableHowler;

const hasActiveUserGesture = (event?: Event): boolean => {
  if (event?.isTrusted) return true;
  const activation = globalThis.navigator?.userActivation;
  return Boolean(activation?.isActive);
};

const ensureAudioContext = (): UnlockableHowler => {
  const howler = unlockableHowler();
  // Howler creates its AudioContext lazily from any global volume access.
  // Doing so before the first gesture lets Howler install its capture-phase
  // unlock listeners in time instead of discovering audio only at first BGM.
  if (!howler.ctx) void Howler.volume();
  if (!howler._audioUnlocked && !fallbackUnlockArmed) {
    howler._unlockAudio?.();
    fallbackUnlockArmed = true;
  }
  return howler;
};

const prepareHtml5Pool = (howler: UnlockableHowler): void => {
  if (typeof Audio !== "function") return;
  const pool = howler._html5AudioPool;
  if (!pool) return;
  const target = Math.max(1, Number(howler.html5PoolSize) || 10);
  while (pool.length < target) {
    try {
      const audio = new Audio() as UnlockableAudioElement;
      audio._unlocked = true;
      if (howler._releaseHtml5Audio) howler._releaseHtml5Audio(audio);
      else pool.push(audio);
    } catch {
      break;
    }
  }

  // A streaming sound may have been constructed before the host forwarded
  // its gesture. Include those assigned nodes in the same unlock operation.
  for (const howl of howler._howls || []) {
    if (howl._webAudio) continue;
    for (const id of howl._getSoundIds?.() || []) {
      const node = howl._soundById?.(id)?._node;
      if (!node || node._unlocked) continue;
      node._unlocked = true;
      try {
        node.load();
      } catch {}
    }
  }
};

const finishImmediateUnlock = (howler: UnlockableHowler): void => {
  immediateUnlockPending = false;
  if (howler._audioUnlocked) return;
  howler._audioUnlocked = true;
  for (const howl of howler._howls || []) howl._emit?.("unlock");
};

/** @internal Used by the sound manager to avoid allocating locked media nodes. */
export function canUseStoryHtml5Audio(): boolean {
  const howler = unlockableHowler();
  return !Howler.usingWebAudio || Boolean(howler._audioUnlocked) || trustedGesturePrepared;
}

/**
 * Arms audio before playback and consumes a forwarded trusted gesture when
 * available. The operation is synchronous and idempotent, so framework roots
 * can safely use it as a capture handler as well as before start/advance.
 */
export function prepareStoryAudio(event?: Event): void {
  if (typeof window === "undefined" || typeof document === "undefined") return;
  const howler = ensureAudioContext();
  if (howler._audioUnlocked || !hasActiveUserGesture(event)) return;

  prepareHtml5Pool(howler);
  trustedGesturePrepared = true;
  const context = howler.ctx;
  if (!context || immediateUnlockPending) return;
  immediateUnlockPending = true;

  try {
    const source = context.createBufferSource();
    source.buffer = context.createBuffer(1, 1, 22050);
    source.connect(context.destination);
    source.onended = () => {
      try {
        source.disconnect();
      } catch {}
      finishImmediateUnlock(howler);
    };
    source.start(0);
  } catch {
    immediateUnlockPending = false;
  }

  try {
    const resumed = context.resume?.();
    void resumed?.then(
      () => finishImmediateUnlock(howler),
      () => {
        trustedGesturePrepared = false;
        immediateUnlockPending = false;
      },
    );
  } catch {
    trustedGesturePrepared = false;
    immediateUnlockPending = false;
  }
}
