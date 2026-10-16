import type { VegaSaveStorage } from "../../narrative/save";

export class VegaLocalStorageSaveStorage implements VegaSaveStorage {
  constructor(private readonly storage: Storage = globalThis.localStorage) {}

  async read(key: string): Promise<string | null> {
    return this.storage.getItem(key);
  }

  async write(key: string, value: string): Promise<void> {
    this.storage.setItem(key, value);
  }

  async remove(key: string): Promise<void> {
    this.storage.removeItem(key);
  }

  async list(prefix: string): Promise<readonly string[]> {
    const keys: string[] = [];
    for (let index = 0; index < this.storage.length; index += 1) {
      const key = this.storage.key(index);
      if (key?.startsWith(prefix)) keys.push(key);
    }
    return keys.sort();
  }
}
