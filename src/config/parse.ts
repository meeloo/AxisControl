// Reading a machine's configuration files, line by line.
//
// This parser exists to make config.g legible, not to interpret it. It reads
// one line at a time and records what it can see — the command, its
// parameters, the comment, and whether the line sits inside a conditional. It
// never rewrites, reorders or normalises anything, and the line's original text
// is kept verbatim so that anything editing a value later can put it back with
// only those characters changed.
//
// The most important thing here is what it refuses to claim. A line carrying a
// {expression}, a line inside an `if` or `while`, a command nobody has
// whitelisted: all parsed as far as they go and then marked not-editable. A
// parser that guesses at a machine's configuration is worse than one that
// shrugs, because the shrug is visible and the guess is not.
//
// It is a small job on a real machine. The config on this one is 77 live
// command lines across config.g and its fragments, with no expressions in any
// of them and no conditionals outside the ATC and dust shoe files.

/** A parameter as written: the letter, and the text after it, unconverted. */
export interface ConfigParam {
  letter: string;
  /** Exactly the characters that followed the letter — "6000.00", "0.1:0.2", "\"pin\"". */
  text: string;
  /** The number, when the text is one. Lists, strings and expressions give null. */
  value: number | null;
}

export type LineKind =
  /** A command RRF will run. */
  | 'command'
  /** A command that has been commented out — often the previous value. */
  | 'disabled'
  /** `if`, `while`, `set`, `var`, `echo`, `abort`… */
  | 'meta'
  /** Comment or blank. */
  | 'note';

export interface ConfigLine {
  /** 0-based index into the file, so an edit can find the line again. */
  index: number;
  /** The line exactly as it appears, without its newline. */
  raw: string;
  kind: LineKind;
  /** "M203", "G10", "M98" — absent on notes and meta lines. */
  command: string | null;
  params: ConfigParam[];
  /** Comment text without the leading `;`, or null. */
  comment: string | null;
  /** How many `if`/`while` blocks enclose this line. */
  depth: number;
  /** Set when the line carries a {…} expression anywhere. */
  expression: boolean;
}

export interface ConfigFile {
  /** Absolute path on the controller, e.g. "/sys/config-axes.g". */
  path: string;
  lines: ConfigLine[];
  /** Paths this file runs with M98, in the order it runs them. */
  includes: string[];
}

const COMMAND = /^([GMT])(\d+(?:\.\d+)?)/i;
const META = /^(if|elif|else|while|break|continue|var|set|global|echo|abort|return)\b/i;

/**
 * Split a command's parameters.
 *
 * Walks rather than matching a regex, because a parameter's value can be a
 * quoted string containing anything at all (`M550 P"Seb's CNC"`), a
 * driver list (`0.1:0.2`), or a braced expression that may itself contain
 * letters and spaces (`Z{move.axes[2].max}`). Each of those would break a
 * naive split on letters.
 */
function splitParams(text: string): ConfigParam[] {
  const out: ConfigParam[] = [];
  let i = 0;
  while (i < text.length) {
    const ch = text[i]!;
    if (!/[A-Za-z]/.test(ch)) {
      i++;
      continue;
    }
    const letter = ch.toUpperCase();
    i++;
    const start = i;
    // Consume the value: a quoted string, a braced expression, or a run of
    // anything that is not whitespace and does not start the next parameter.
    if (text[i] === '"') {
      i++;
      while (i < text.length && text[i] !== '"') i++;
      i++;
    } else if (text[i] === '{') {
      let depth = 0;
      do {
        if (text[i] === '{') depth++;
        else if (text[i] === '}') depth--;
        i++;
      } while (i < text.length && depth > 0);
    } else {
      while (i < text.length && /[^\s;]/.test(text[i]!) && !/[A-Za-z]/.test(text[i]!)) i++;
      // A letter directly after digits starts the next parameter, but a letter
      // inside a value like "0.1:0.2" cannot occur, so this is safe.
    }
    const raw = text.slice(start, i).trim();
    const numeric = /^[+-]?(\d+\.?\d*|\.\d+)$/.test(raw);
    out.push({ letter, text: raw, value: numeric ? Number(raw) : null });
  }
  return out;
}

/** Where the comment starts, ignoring `;` inside a quoted string. */
function commentAt(line: string): number {
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    if (line[i] === '"') quoted = !quoted;
    else if (line[i] === ';' && !quoted) return i;
  }
  return -1;
}

export function parseConfig(path: string, text: string): ConfigFile {
  const lines: ConfigLine[] = [];
  const includes: string[] = [];
  let depth = 0;

  text.split(/\r?\n/).forEach((raw, index) => {
    const cut = commentAt(raw);
    const code = (cut < 0 ? raw : raw.slice(0, cut)).trim();
    const comment = cut < 0 ? null : raw.slice(cut + 1).trim();

    const line: ConfigLine = {
      index,
      raw,
      kind: 'note',
      command: null,
      params: [],
      comment,
      depth,
      expression: raw.includes('{'),
    };

    if (code) {
      const meta = META.exec(code);
      if (meta) {
        line.kind = 'meta';
        // Closing happens by indentation in RRF, but the block structure that
        // matters here is only "is this line conditional", and an if/while
        // opening is enough to say the lines that follow might be.
        const word = meta[1]!.toLowerCase();
        if (word === 'if' || word === 'while') depth++;
        else if (word === 'else' || word === 'elif') line.depth = Math.max(0, depth - 1);
      } else {
        const cmd = COMMAND.exec(code);
        if (cmd) {
          line.kind = 'command';
          line.command = `${cmd[1]!.toUpperCase()}${cmd[2]}`;
          line.params = splitParams(code.slice(cmd[0].length));
          if (line.command === 'M98') {
            const p = line.params.find((x) => x.letter === 'P');
            if (p) includes.push(p.text.replace(/^"|"$/g, ''));
          }
        }
      }
    } else if (comment) {
      // A commented-out command is worth recognising rather than dropping: it
      // is usually the value that was there before, which is exactly the thing
      // somebody tuning wants to see. config-axes.g on this machine keeps four
      // of them directly above their live replacements.
      const inner = comment.replace(/^;+\s*/, '');
      const cmd = COMMAND.exec(inner);
      if (cmd && /^[GM]/i.test(inner)) {
        line.kind = 'disabled';
        line.command = `${cmd[1]!.toUpperCase()}${cmd[2]}`;
        line.params = splitParams(inner.slice(cmd[0].length).split(';')[0] ?? '');
      }
    }

    lines.push(line);
  });

  // Dedent trailing blocks: RRF closes them by outdenting, which this parser
  // does not track. Depth is therefore an upper bound — "might be conditional"
  // rather than "is". For deciding what to leave alone, erring high is right.
  return { path, lines, includes };
}

/** Whether a value in this line can be safely rewritten in place. */
export function editable(line: ConfigLine, whitelist: ReadonlySet<string>): boolean {
  return (
    line.kind === 'command' &&
    !line.expression &&
    line.depth === 0 &&
    line.command !== null &&
    whitelist.has(line.command)
  );
}
