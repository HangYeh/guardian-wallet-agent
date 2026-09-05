import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fixturesMode, recording } from '@/lib/fixtures';

/**
 * ElevenLabs 語音。阿嬤那一句是唸給她聽的，不是給她讀的。
 *
 * 三層，由近到遠：
 *   1. 錄好的音檔 `demo-data/audio/<key>.mp3` —— 進 repo，**舞台保險絲**：
 *      劇本裡那幾句不需要金鑰、不需要網路就唸得出來（跟 `fixtures.ts` 同一個思路）。
 *   2. 執行期快取 `public/audio-cache/<key>.mp3` —— 同一句話只跟 ElevenLabs 要一次。
 *      `.gitignore` 早就排除它，因為這裡會出現任何人貼進來的文字的語音。
 *   3. ElevenLabs API —— `ENABLE_TTS=true` 而且有金鑰才會打。
 *
 * 沒 key、關掉、`DEMO_MODE=fixtures`、或網路壞掉：回 null / 丟 TtsError，
 * 呼叫端退回瀏覽器內建語音或純文字。**語音壞了畫面不能跟著壞。**
 *
 * 鍵是 sha256(model, voice, text)：換聲音或換模型自動失效，不會拿 Sarah 的檔案冒充別人。
 */

/** Sarah。賽前用 pick-voice 聽過三個，這個唸中文最自然。 */
export const DEFAULT_VOICE = 'EXAVITQu4vr4xnSDxMaL';
export const DEFAULT_TTS_MODEL = 'eleven_multilingual_v2';
/** 一次能唸的長度。週報 90 字、攔截那句 60 字，300 已經是三倍餘裕；再長就是有人在燒額度。 */
export const SPEECH_TEXT_MAX = 300;
/** 64 kbps 的 mp3：一句話約 30–60 KB，進 repo 也不心疼。 */
const OUTPUT_FORMAT = 'mp3_44100_64';
const TIMEOUT_MS = 15_000;

function recordedDir(): string {
  return process.env.GUARDIAN_AUDIO_DIR ?? join(process.cwd(), 'demo-data', 'audio');
}
function cacheDir(): string {
  return process.env.GUARDIAN_AUDIO_CACHE_DIR ?? join(process.cwd(), 'public', 'audio-cache');
}

export class TtsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TtsError';
  }
}

export function ttsEnabled(): boolean {
  return process.env.ENABLE_TTS === 'true' && Boolean(process.env.ELEVENLABS_API_KEY?.trim());
}

export function ttsVoice(): string {
  return process.env.ELEVENLABS_VOICE_ID?.trim() || DEFAULT_VOICE;
}

export function ttsModel(): string {
  return process.env.ELEVENLABS_MODEL?.trim() || DEFAULT_TTS_MODEL;
}

/** 控制字元清掉、前後空白修掉。回傳 null 代表這段文字不該唸（空的或太長）。 */
export function normalizeSpeechText(text: string): string | null {
  const clean = text.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!clean || clean.length > SPEECH_TEXT_MAX) return null;
  return clean;
}

export function speechKey(text: string, voice = ttsVoice(), model = ttsModel()): string {
  // U+001F 當分隔符，理由同 fixtures.ts 的 fixtureKey：直接接起來會撞鍵。
  return createHash('sha256').update([model, voice, text].join(String.fromCharCode(31))).digest('hex');
}

export type SpeechSource = 'recorded' | 'cache' | 'elevenlabs';
export type Speech = { audio: Buffer; source: SpeechSource; key: string };

function readIf(file: string): Buffer | null {
  try {
    /*turbopackIgnore: true*/
    return existsSync(file) ? readFileSync(file) : null;
  } catch {
    return null; // 壞掉的檔案當作沒有，往下一層走
  }
}

function writeTo(dir: string, key: string, audio: Buffer): void {
  try {
    /*turbopackIgnore: true*/
    mkdirSync(dir, { recursive: true });
    /*turbopackIgnore: true*/
    writeFileSync(join(dir, `${key}.mp3`), audio);
  } catch {
    // 快取寫不進去不是錯：聲音已經拿到了，這次照放，下次再要一次而已。
  }
}

/**
 * 把一句話變成 mp3。回 null 代表「現在沒有辦法唸這句」（關掉、沒錄、離線模式）；
 * 真的去打 ElevenLabs 而失敗才丟 TtsError。呼叫端兩種都要接。
 */
export async function synthesize(text: string): Promise<Speech | null> {
  const clean = normalizeSpeechText(text);
  if (!clean) return null;
  const key = speechKey(clean);

  const recorded = readIf(join(recordedDir(), `${key}.mp3`));
  if (recorded) return { audio: recorded, source: 'recorded', key };

  const cached = readIf(join(cacheDir(), `${key}.mp3`));
  if (cached) return { audio: cached, source: 'cache', key };

  // 離線模式的意思就是不碰網路 —— 沒錄到的句子寧可不唸。
  // 唯一的例外是錄音模式：RECORD_FIXTURES=true 就是「去把這句錄下來」，
  // 而且錄音一定要在 fixtures 模式下做，模型那邊才不會被順手重錄。
  if (!ttsEnabled()) return null;
  if (fixturesMode() && !recording()) return null;

  const audio = await callElevenLabs(clean);
  writeTo(cacheDir(), key, audio);
  if (recording()) writeTo(recordedDir(), key, audio);
  return { audio, source: 'elevenlabs', key };
}

async function callElevenLabs(text: string): Promise<Buffer> {
  const apiKey = process.env.ELEVENLABS_API_KEY!.trim();
  const url = `https://api.elevenlabs.io/v1/text-to-speech/${ttsVoice()}?output_format=${OUTPUT_FORMAT}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'xi-api-key': apiKey,
        'content-type': 'application/json',
        accept: 'audio/mpeg',
      },
      body: JSON.stringify({ text, model_id: ttsModel() }),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      // 錯誤內文可能帶著我們送出去的字，截短就好；金鑰不會在回應裡。
      const detail = (await res.text()).replace(/\s+/g, ' ').slice(0, 160);
      throw new TtsError(`ElevenLabs 回 ${res.status}：${detail}`);
    }
    return Buffer.from(await res.arrayBuffer());
  } catch (err) {
    if (err instanceof TtsError) throw err;
    const reason = err instanceof Error && err.name === 'AbortError' ? `${TIMEOUT_MS / 1000} 秒沒回應` : String(err);
    throw new TtsError(`ElevenLabs 連不上：${reason}`);
  } finally {
    clearTimeout(timer);
  }
}

export function audioDirs(): { recorded: string; cache: string } {
  return { recorded: recordedDir(), cache: cacheDir() };
}
