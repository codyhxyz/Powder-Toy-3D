// The announcer's voice clips (public/announcer/<KEY>.mp3), made once with ElevenLabs and
// committed: the game only plays files (src/pov/announcer.js), and speaks a line with the
// browser's voice where no clip exists yet. Halo 3's announcer is a real person's voice and
// Bungie's recordings, so neither is copied: the voice is ElevenLabs' stock "Brian", read
// by Eleven v4 with a direction in square brackets, picked by ear with the user (2026-10-11:
// "booming" over a growl, a stutter and two other voices).
//
// The key: ELEVENLABS_API_KEY in the environment or in ~/.claude/secrets/elevenlabs.env
// (never in the repo). The free plan's audio is for non-commercial use with ElevenLabs
// credited; a paid plan lifts both.
//
// usage:
//   node tools/announcer-voice.mjs --missing         every manifest line without a clip yet
//   node tools/announcer-voice.mjs KEY [KEY…]        just those lines (--force remakes existing clips)
//   node tools/announcer-voice.mjs --dry …           print what would be read, and its characters (the cost)
import { writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const API = 'https://api.elevenlabs.io/v1';
const OUT = join(ROOT, 'public/announcer');
const VOICE = 'nPczCjzI2devNBz1zQrb';    // ElevenLabs' stock "Brian": deep, resonant
const MODEL = 'eleven_v4';
const DIRECTION = '[deep, gravelly, slow, booming]';   // Eleven v4 reads a bracketed direction as how to act the line
const FORMAT = 'mp3_44100_128';           // fetched at full quality, then trimmed, levelled and re-encoded below
// ffmpeg: trim the silence at both ends, level to a loud voice line (−14 LUFS, peaks under −1.5 dBFS), mono 64 kbps
const SILENCE_DB = -50;
const LOUDNESS = 'loudnorm=I=-14:TP=-1.5:LRA=11';
const BITRATE = '64k';

function apiKey() {
  if (process.env.ELEVENLABS_API_KEY) return process.env.ELEVENLABS_API_KEY;
  const file = join(homedir(), '.claude/secrets/elevenlabs.env');
  const m = existsSync(file) && readFileSync(file, 'utf8').match(/^ELEVENLABS_API_KEY=(.+)$/m);
  if (!m) throw new Error('No ElevenLabs key: set ELEVENLABS_API_KEY or put ELEVENLABS_API_KEY=… in ~/.claude/secrets/elevenlabs.env');
  return m[1].trim();
}

async function speak(text) {
  const res = await fetch(`${API}/text-to-speech/${VOICE}?output_format=${FORMAT}`, {
    method: 'POST',
    headers: { 'xi-api-key': apiKey(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: `${DIRECTION} ${text}`, model_id: MODEL }),
  });
  if (!res.ok) throw new Error(`text-to-speech: HTTP ${res.status} ${(await res.text()).slice(0, 300)}`);
  return Buffer.from(await res.arrayBuffer());
}

const args = process.argv.slice(2);
const force = args.includes('--force'), dry = args.includes('--dry'), missing = args.includes('--missing');
const keys = args.filter((a) => !a.startsWith('--'));
if (!missing && !keys.length) throw new Error('Name the lines (KEY …) or pass --missing');
const lines = JSON.parse(execFileSync('node', [join(ROOT, 'tools/announcer-lines.mjs')], { encoding: 'utf8' }));
const unknown = keys.filter((k) => !lines.some((l) => l.key === k));
if (unknown.length) throw new Error(`Not in the manifest: ${unknown.join(', ')}`);
const todo = lines.filter((l) => (missing || keys.includes(l.key)) && (force || !existsSync(join(OUT, `${l.key}.mp3`))));
const chars = todo.reduce((n, l) => n + DIRECTION.length + 1 + l.text.length, 0);
console.log(`${todo.length} lines, ${chars} characters`);
if (dry) { for (const l of todo) console.log(`  ${l.key}: ${l.text}`); process.exit(0); }

mkdirSync(OUT, { recursive: true });
const raw = join(tmpdir(), 'announcer-raw.mp3');
const trim = `silenceremove=start_periods=1:start_threshold=${SILENCE_DB}dB`;
for (const { key, text } of todo) {
  writeFileSync(raw, await speak(text));
  const file = join(OUT, `${key}.mp3`);
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', raw, '-af', `${trim},areverse,${trim},areverse,${LOUDNESS}`, '-ac', '1', '-b:a', BITRATE, file]);
  console.log(`${key}: "${text}" → public/announcer/${key}.mp3`);
}
