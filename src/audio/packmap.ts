/**
 * Guess which drum voice a sample is from its file name (and folder), the way packs are usually
 * named: "Kick 01.wav", "Hats/Open Hat 3.wav", "BD0025.WAV", "SNR_Tight.wav", "Perc - Conga Hi.wav"…
 */

interface Rule {
  pitch: number;
  re: RegExp;
  /** Matched but excluded (an open-hat rule must not take "closed hat"). */
  not?: RegExp;
}

// Most specific first: the first rule that matches the file name wins.
const RULES: Rule[] = [
  { pitch: 46, re: /open.*(hat|(^|[^a-z])hh)|(hat|(^|[^a-z])hh).*open|(^|[^a-z])(oh|ohh|ophh|hho)(?![a-z])|hh ?o(?![a-z])/ },
  { pitch: 42, re: /closed ?hat|closed ?hi|hi ?-?hat|hihat|(^|[^a-z])(ch|chh|clhh|hhc|hh|hat|hats)(?![a-z])|hh ?c(?![a-z])/, not: /open/ },
  { pitch: 70, re: /shak|maraca|cabasa|(^|[^a-z])(ma|shk)(?![a-z])/ },
  { pitch: 54, re: /tamb/ },
  { pitch: 81, re: /triang/ },
  { pitch: 56, re: /cow ?bell|(^|[^a-z])cb(?![a-z])|agogo/ },
  { pitch: 76, re: /wood ?block|block|clave|(^|[^a-z])(cl|wb)(?![a-z])/ },
  { pitch: 64, re: /(low|lo)[ _-]?conga|conga[ _-]?(low|lo)|tumba|(^|[^a-z])lc(?![a-z])/ },
  { pitch: 63, re: /conga|(^|[^a-z])(mc|hc)(?![a-z])/ },
  { pitch: 60, re: /bongo/ },
  { pitch: 31, re: /snap|finger|(^|[^a-z])fs(?![a-z])/ },
  { pitch: 39, re: /clap|(^|[^a-z])(cp|clp)(?![a-z])/ },
  { pitch: 37, re: /(^|[^a-z])rim|side ?stick|cross ?stick|(^|[^a-z])(rs|stick)(?![a-z])/ },
  { pitch: 38, re: /snare|snr|(^|[^a-z])(sd|sn)(?![a-z])/ },
  { pitch: 49, re: /crash|splash|china|(^|[^a-z])(cr|cy|cym|cymbal)(?![a-z])/ },
  { pitch: 51, re: /(^|[^a-z])(ride|rd)(?![a-z])/ },
  { pitch: 45, re: /(floor|low|lo)[ -]?toms?(?![a-z])|(^|[^a-z])toms? ?-? ?(floor|low|lo|[34](?![0-9]))|(^|[^a-z])(lt|ft)(?![a-z])/ },
  { pitch: 50, re: /(high|hi)[ -]?toms?(?![a-z])|(^|[^a-z])toms? ?-? ?(high|hi|1(?![0-9]))|(^|[^a-z])ht(?![a-z])/ },
  { pitch: 47, re: /(mid|med)[ -]?toms?(?![a-z])|(^|[^a-z])toms? ?-? ?(mid|med|2(?![0-9]))|(^|[^a-z])mt(?![a-z])|(^|[^a-z])toms?(?![a-z])/ },
  { pitch: 36, re: /kick|kik|kck|bass ?drum|bassdrum|(^|[^a-z])(bd|kd|bt)(?![a-z])/ },
];

/** A bare "808" (or "sub", "bass") is a tuned bass note, not a drum voice. */
const BASS = /(^|[^a-z0-9])(808s?|sub|bass)(?![a-z])/;

function clean(s: string): string {
  return s
    .toLowerCase()
    .replace(/\.[a-z0-9]+$/, '')
    .replace(/([a-z])([0-9])/g, '$1 $2')
    .replace(/[_.]+/g, ' ');
}

/** The drum voice (GM pitch) a sample path most likely is, or null. The file name beats the folder. */
export function guessVoice(path: string): number | null {
  const parts = path.split(/[\\/]/);
  const file = clean(parts[parts.length - 1]);
  const dirs = parts.slice(0, -1).map(clean).reverse();
  for (const text of [file, ...dirs]) {
    if (BASS.test(text) && !/kick|kik|kck|bd|bass ?drum/.test(text)) return text === file ? null : guessFromRules(file);
    const hit = guessFromRules(text);
    if (hit !== null) return hit;
  }
  return null;
}

function guessFromRules(text: string): number | null {
  for (const r of RULES) if (r.re.test(text) && !(r.not && r.not.test(text))) return r.pitch;
  return null;
}

/** Natural sort ("Kick 2" before "Kick 10"). */
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
export function naturalCompare(a: string, b: string): number {
  return collator.compare(a, b);
}

/**
 * Pick one file per voice: the first match in natural order. Toms without a size spread over low,
 * mid and high when the pack only names them "Tom 1, Tom 2…". Returns pitch → index into `paths`.
 */
export function autoMap(paths: string[]): Map<number, number> {
  const order = paths.map((_, i) => i).sort((a, b) => naturalCompare(paths[a], paths[b]));
  const map = new Map<number, number>();
  const toms: number[] = [];
  for (const i of order) {
    const v = guessVoice(paths[i]);
    if (v === null) continue;
    if (v === 47 && !/mid|med|toms? ?-? ?2(?![0-9])|(^|[^a-z])mt(?![a-z])/.test(clean(paths[i]))) toms.push(i);
    if (!map.has(v)) map.set(v, i);
  }
  // Generic toms: first three spread over high/mid/low when those weren't named.
  if (toms.length >= 2 && !map.has(45) && !map.has(50)) {
    const [hi, mid, lo] = toms.length >= 3 ? toms : [toms[0], toms[0], toms[1]];
    map.set(50, hi);
    map.set(47, mid);
    map.set(45, lo);
  }
  return map;
}

export const AUDIO_EXT = /\.(wav|wave|aif|aiff|mp3|ogg|oga|flac|m4a|aac|opus|webm)$/i;
