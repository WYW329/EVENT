// 狀態存放：訂閱、收藏、已通知過的活動、手動加入的活動。
// 線上（Render 免費方案沒有永久硬碟）存在一個私密 GitHub Gist；本機開發存在 data-local/state.json。
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const EMPTY = () => ({ subs: {}, seen: { ids: [], seededAt: null }, sent: {}, manual: [] });

function normalize(s) {
  const base = EMPTY();
  return { ...base, ...s, seen: { ...base.seen, ...(s?.seen ?? {}) } };
}

class LocalStore {
  constructor(file = process.env.STATE_FILE || join(ROOT, 'data-local', 'state.json')) {
    this.file = file;
    this.kind = 'local';
  }
  async load() {
    try {
      return normalize(JSON.parse(await readFile(this.file, 'utf8')));
    } catch {
      return EMPTY();
    }
  }
  async save(state) {
    await mkdir(dirname(this.file), { recursive: true });
    await writeFile(this.file, JSON.stringify(state, null, 1));
  }
}

class GistStore {
  constructor(id, token) {
    this.id = id;
    this.token = token;
    this.kind = 'gist';
  }
  headers() {
    return { Authorization: `Bearer ${this.token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'taoyuan-events' };
  }
  async load() {
    const res = await fetch(`https://api.github.com/gists/${this.id}`, { headers: this.headers() });
    if (!res.ok) throw new Error(`讀取 Gist 失敗：HTTP ${res.status}`);
    const gist = await res.json();
    const file = gist.files?.['state.json'];
    if (!file) return EMPTY();
    let text = file.content;
    if (file.truncated) text = await (await fetch(file.raw_url, { headers: this.headers() })).text();
    try {
      return normalize(JSON.parse(text));
    } catch {
      return EMPTY();
    }
  }
  async save(state) {
    const res = await fetch(`https://api.github.com/gists/${this.id}`, {
      method: 'PATCH',
      headers: { ...this.headers(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ files: { 'state.json': { content: JSON.stringify(state) } } }),
    });
    if (!res.ok) throw new Error(`寫入 Gist 失敗：HTTP ${res.status}`);
  }
}

/** 狀態放在記憶體，變更後 2 秒內合併寫回一次。 */
export class State {
  constructor(backend) {
    this.backend = backend;
    this.data = EMPTY();
    this.timer = null;
    this.saving = Promise.resolve();
  }
  async init() {
    this.data = await this.backend.load();
    return this;
  }
  touch() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), 2000);
  }
  async flush() {
    clearTimeout(this.timer);
    this.timer = null;
    this.saving = this.saving.then(() => this.backend.save(this.data)).catch((err) => console.error('[store]', err.message));
    return this.saving;
  }
}

export function makeBackend() {
  if (process.env.GIST_ID && process.env.GIST_TOKEN) return new GistStore(process.env.GIST_ID, process.env.GIST_TOKEN);
  return new LocalStore();
}
