// Colouring a G-code file.
//
// Text in, HTML in spans out. Deliberately a string rather than a DOM tree: it
// is rebuilt on every keystroke, and one innerHTML assignment beats a few
// thousand element creations on a config file of any size.
//
// What gets a colour is chosen by what goes wrong when reading these files. The
// command and its parameter letters, because a stray letter is the classic
// typo. Strings, because `M98 P"homez.g"` with the quote missed is a file that
// silently does nothing. Braces, because RRF's expressions look exactly like
// ordinary text and behave nothing like it — telling {move.axes[2].max} from
// the literal characters is most of reading a modern config.
//
// Escaping is not optional here: the text is a file off the machine, and it
// goes into innerHTML.

const KEYWORDS = new Set([
  'if',
  'elif',
  'else',
  'while',
  'break',
  'continue',
  'return',
  'abort',
  'echo',
  'set',
  'global',
  'var',
]);

/** Anything that can start a parameter's value, which is what makes a bare letter a parameter. */
const VALUE_AHEAD = /[-+.\d"{[]/;

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function span(cls: string, text: string): string {
  return `<span class="hl-${cls}">${esc(text)}</span>`;
}

/** The end of a quoted string, quote included; the end of the line if it is unterminated. */
function endOfString(line: string, start: number): number {
  for (let i = start + 1; i < line.length; i++) {
    if (line[i] === '\\') i++;
    else if (line[i] === '"') return i + 1;
  }
  return line.length;
}

/** The end of a braced expression, counting nesting — RRF expressions do nest. */
function endOfBrace(line: string, start: number): number {
  let depth = 0;
  for (let i = start; i < line.length; i++) {
    if (line[i] === '{') depth++;
    else if (line[i] === '}' && --depth === 0) return i + 1;
  }
  return line.length;
}

function highlightLine(line: string): string {
  let out = '';
  let i = 0;
  // Whether a command may still start here.
  //
  // True at the start of the line, and still true after a G-code, because those
  // chain: `G53 G0 X0` is one move with a modifier, not a command followed by a
  // parameter. Not after an M-code or a T, which end the matter — the T in
  // `M581.1 T2` is that command's trigger number, and colouring it as a tool
  // change would be a lie about what the line does.
  let commandsOnly = true;

  while (i < line.length) {
    const rest = line.slice(i);
    const ch = line[i];

    if (ch === ';') {
      out += span('cm', rest);
      break;
    }
    if (/\s/.test(ch)) {
      const ws = /^\s+/.exec(rest)![0];
      out += esc(ws);
      i += ws.length;
      continue;
    }
    if (ch === '"') {
      const end = endOfString(line, i);
      out += span('st', line.slice(i, end));
      i = end;
      commandsOnly = false;
      continue;
    }
    if (ch === '{') {
      const end = endOfBrace(line, i);
      out += span('ex', line.slice(i, end));
      i = end;
      commandsOnly = false;
      continue;
    }

    const command = commandsOnly ? /^[GMTgmt]\d+(?:\.\d+)?/.exec(rest) : null;
    if (command) {
      out += span('cmd', command[0]);
      i += command[0].length;
      commandsOnly = /^[Gg]/.test(command[0]);
      continue;
    }

    // A bare letter with a value behind it. Checked before words, or `S3` would
    // be read as one identifier and the parameter would lose its colour.
    if (/^[A-Za-z]/.test(rest) && rest.length > 1 && VALUE_AHEAD.test(rest[1])) {
      out += span('par', ch);
      i += 1;
      commandsOnly = false;
      continue;
    }

    const word = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+|\[[^\]]*\])*/.exec(rest);
    if (word) {
      const w = word[0];
      if (KEYWORDS.has(w)) out += span('kw', w);
      else if (w === 'true' || w === 'false') out += span('bool', w);
      else out += esc(w);
      i += w.length;
      commandsOnly = false;
      continue;
    }

    const number = /^[-+]?(?:\d+\.?\d*|\.\d+)/.exec(rest);
    if (number) {
      out += span('num', number[0]);
      i += number[0].length;
      commandsOnly = false;
      continue;
    }

    out += esc(ch);
    i += 1;
    commandsOnly = false;
  }

  return out;
}

/** Colour a whole file, as one string. Mostly useful for testing the tokeniser. */
export function highlightGcode(text: string): string {
  return text.split('\n').map(highlightLine).join('\n');
}

/**
 * Paint the colour layer, one element per line, touching only what changed.
 *
 * The obvious version — rebuild the whole layer's innerHTML on every keystroke
 * — measured 208 ms per character on a 111 KiB file. Typing at that speed is
 * not typing. A keystroke only ever changes the line the caret is on, so each
 * line keeps the text it was built from and is left alone when it still
 * matches; the cost of a keystroke becomes the cost of one line whatever the
 * file's size, and only opening it pays for the whole thing.
 *
 * A line per element also fixes the height of empty lines, which is why the
 * zero-width space is there: an empty div collapses, and one collapsed line
 * puts every line below it out of step with the text above the layer.
 */
export function paintGcode(layer: HTMLElement, text: string, colour = true): void {
  const lines = text.split('\n');
  // A change of mode rewrites every line; without this a file opened as G-code
  // and then as plain text would keep the colour it no longer deserves.
  if (layer.dataset.colour !== String(colour)) {
    layer.dataset.colour = String(colour);
    layer.replaceChildren();
  }

  for (let i = 0; i < lines.length; i++) {
    let el = layer.children[i] as HTMLElement | undefined;
    if (!el) {
      el = document.createElement('div');
      layer.appendChild(el);
    }
    if (el.dataset.src === lines[i]) continue;
    el.dataset.src = lines[i];
    // Plain files still get a line per div — that is what the numbers count.
    if (colour) el.innerHTML = highlightLine(lines[i]) || '&#8203;';
    else el.textContent = lines[i] || '\u200b';
  }

  while (layer.children.length > lines.length) layer.lastElementChild!.remove();
}
