// Flashing a file somebody chose themselves.
//
// Every other check in this repo protects against a wrong readout or a wasted
// afternoon. This one protects the board: the file it plans to write is the one
// the controller will copy into its own flash, and a wrong or truncated image
// there is a machine that does not boot and cannot be talked to. So the
// interesting assertions here are all refusals.
//
// The UF2 constants are checked against the format's own specification
// (microsoft/uf2), not against what this code happens to emit — a fixture built
// from the same assumption as the parser proves only that they agree with each
// other. The synthetic images below are assembled byte by byte to the spec:
// 512-byte blocks, magic 0x0A324655 / 0x9E5D5157 at the front and 0x0AB16F30 at
// the back, payload size at offset 16, block index at 20, block count at 24,
// familyID at 28 when flag 0x2000 is set.
//
//   npm run firmware-check

import { build } from 'esbuild';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { deflateRawSync, crc32 } from 'node:zlib';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dir = await mkdtemp(join(tmpdir(), 'fw-'));
const out = join(dir, 'fw.mjs');
const entry = join(dir, 'entry.ts');
await writeFile(entry, `export * as fw from ${JSON.stringify(join(root, 'src/machine/firmware.ts'))};\n`);
await build({ entryPoints: [entry], bundle: true, format: 'esm', outfile: out, logLevel: 'error',
  platform: 'neutral', mainFields: ['module', 'main'], conditions: ['browser'] });
const { fw } = await import(pathToFileURL(out).href);

const fails = [];
const ok = (c, w, x = '') => { console.log(`${c ? 'PASS' : 'FAIL'}  ${w}${x ? '  ' + x : ''}`); if (!c) fails.push(w); };
const refuses = async (what, fn, wanted) => {
  let threw = null;
  try { await fn(); } catch (e) { threw = e; }
  const matched = threw && (!wanted || wanted.test(threw.message));
  ok(matched, what, threw ? threw.message.slice(0, 110) : 'did not refuse');
};

// --- Synthetic UF2, to the specification ------------------------------------

function uf2(blocks, { familyId = 0x11223344, totalOverride = null, breakBlock = -1, payload = 256 } = {}) {
  const bytes = new Uint8Array(blocks * 512);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < blocks; i++) {
    const at = i * 512;
    view.setUint32(at, 0x0a324655, true);
    view.setUint32(at + 4, 0x9e5d5157, true);
    view.setUint32(at + 8, familyId === null ? 0 : 0x00002000, true);
    view.setUint32(at + 12, 0x08000000 + i * payload, true);
    view.setUint32(at + 16, payload, true);
    view.setUint32(at + 20, i, true);
    view.setUint32(at + 24, totalOverride ?? blocks, true);
    view.setUint32(at + 28, familyId === null ? 0 : familyId, true);
    for (let b = 0; b < payload; b++) bytes[at + 32 + b] = (i + b) & 0xff;
    view.setUint32(at + 508, i === breakBlock ? 0xdeadbeef : 0x0ab16f30, true);
  }
  return bytes;
}

// A real zip, so the app's own reader is what parses it.
function zip(entries) {
  const chunks = [];
  const central = [];
  let offset = 0;
  for (const [name, data] of entries) {
    const nameBytes = Buffer.from(name, 'utf8');
    const deflated = deflateRawSync(data);
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0, 6);
    local.writeUInt16LE(8, 8); local.writeUInt16LE(0, 10); local.writeUInt16LE(0, 12);
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(deflated.length, 18);
    local.writeUInt32LE(data.length, 22); local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28);
    const head = Buffer.alloc(46);
    head.writeUInt32LE(0x02014b50, 0); head.writeUInt16LE(20, 4); head.writeUInt16LE(20, 6);
    head.writeUInt16LE(0, 8); head.writeUInt16LE(8, 10); head.writeUInt16LE(0, 12);
    head.writeUInt16LE(0, 14); head.writeUInt32LE(crc, 16);
    head.writeUInt32LE(deflated.length, 20); head.writeUInt32LE(data.length, 24);
    head.writeUInt16LE(nameBytes.length, 28); head.writeUInt16LE(0, 30); head.writeUInt16LE(0, 32);
    head.writeUInt16LE(0, 34); head.writeUInt16LE(0, 36); head.writeUInt32LE(0, 38);
    head.writeUInt32LE(offset, 42);
    chunks.push(local, nameBytes, deflated);
    central.push(Buffer.concat([head, nameBytes]));
    offset += local.length + nameBytes.length + deflated.length;
  }
  const dirBytes = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(0, 4); end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(dirBytes.length, 12); end.writeUInt32LE(offset, 16); end.writeUInt16LE(0, 20);
  return new Uint8Array(Buffer.concat([...chunks, dirBytes, end]));
}

const BOARD = {
  board: 'MB6HC', boardName: 'Duet 3 MB6HC', version: '3.6.0', canAddress: 0,
  firmwareFile: 'Duet3Firmware_MB6HC.uf2', iapFile: 'Duet3_SDiap32_MB6HC.bin',
  directory: '/firmware', sbc: false,
};
const IAP_ON_CARD = new Set(['Duet3_SDiap32_MB6HC.bin']);
const good = uf2(2048);                       // 1MB, well-formed

// --- Inspecting a file ------------------------------------------------------

const seen = fw.inspectImage('Duet3Firmware_MB6HC.uf2', good);
ok(seen.kind === 'uf2', 'a well-formed UF2 is recognised', seen.summary);
ok(seen.familyId === 0x11223344, '  and its declared board family is read', seen.summary);
ok(/2048 blocks/.test(seen.summary), '  and the block count is reported', seen.summary);

await refuses('a UF2 with a broken block is refused', () => fw.inspectImage('x.uf2', uf2(64, { breakBlock: 40 })), /block check at block 40/);
await refuses('a UF2 that lies about its length is refused', () => fw.inspectImage('x.uf2', uf2(64, { totalOverride: 999 })), /incomplete/);
await refuses('a UF2 truncated mid-block is refused', () => fw.inspectImage('x.uf2', good.slice(0, good.length - 100)), /whole number of 512-byte/);
await refuses('a file named .uf2 that is not one is refused', () => fw.inspectImage('x.uf2', new Uint8Array(100000)), /does not begin with the UF2 magic/);
await refuses('a truncated download is refused', () => fw.inspectImage('x.bin', new Uint8Array(2000)), /No board image is that small/);
await refuses('an absurdly large file is refused', () => fw.inspectImage('x.bin', new Uint8Array(70 * 1024 * 1024)), /far larger than any board image/);

const raw = fw.inspectImage('Duet3Firmware_MB6HC.bin', new Uint8Array(300000));
ok(raw.kind === 'binary', 'a raw .bin is accepted', raw.summary);
ok(/nothing in a \.bin identifies which board/.test(raw.summary),
   '  and says plainly that nothing about it was verified', raw.summary);

// --- Planning ---------------------------------------------------------------

const plan = await fw.planLocalUpdate({ name: 'Duet3Firmware_MB6HC.uf2', bytes: good }, [BOARD], { present: IAP_ON_CARD });
ok(plan.files.has('/firmware/Duet3Firmware_MB6HC.uf2'), 'the image is written where the board looks for it',
   [...plan.files.keys()].join(', '));
ok(plan.commands.length === 1 && plan.commands[0] === 'M997 S0',
   'and only the main board is flashed — one file is one board', plan.commands.join(', '));
ok(/reusing the Duet3_SDiap32_MB6HC.bin/.test(plan.found.join(' ')),
   '  reusing the programmer already on the card', plan.found.join(' | '));

// A build with a version in the name, which is what a fork actually produces.
const versioned = await fw.planLocalUpdate(
  { name: 'Duet3Firmware_MB6HC-3.7.0-velocity-jog.uf2', bytes: good }, [BOARD], { present: IAP_ON_CARD });
ok(versioned.files.has('/firmware/Duet3Firmware_MB6HC.uf2'),
   'a version infix still matches, and is saved under the plain name',
   [...versioned.files.keys()].join(', '));

// The SBC build is the dangerous one: same board, different image, and DWC's
// matching rule accepts it. A standalone board flashed with it comes up unable
// to answer over the network, which from the outside is a brick.
await refuses('the SBC build of this very board is refused',
  () => fw.planLocalUpdate({ name: 'Duet3Firmware_MB6HC_SBC.uf2', bytes: good }, [BOARD], { present: IAP_ON_CARD }),
  /variant of Duet3Firmware_MB6HC\.uf2 rather than the file itself/);
ok(fw.matchesBoardFile('Duet3Firmware_MB6HC.uf2', 'Duet3Firmware_MB6HC_SBC.uf2'),
   '  which the release rule does accept, which is why there is a stricter one');
ok(!fw.matchesBoardFileStrictly('Duet3Firmware_MB6HC.uf2', 'Duet3Firmware_MB6HC_SBC.uf2'),
   '  and the stricter one does not');
ok(fw.matchesBoardFileStrictly('Duet3Firmware_MB6HC.uf2', 'Duet3Firmware_MB6HC-3.6.1.uf2'),
   '  while a version still passes it');

await refuses('a different board entirely is refused',
  () => fw.planLocalUpdate({ name: 'Duet3Firmware_Mini5plus.uf2', bytes: good }, [BOARD], { present: IAP_ON_CARD }),
  /loads its firmware from Duet3Firmware_MB6HC\.uf2/);

const forced = await fw.planLocalUpdate(
  { name: 'my-build.uf2', bytes: good }, [BOARD], { present: IAP_ON_CARD, acceptMismatchedName: true });
ok(forced.files.has('/firmware/Duet3Firmware_MB6HC.uf2'), 'the override writes it anyway');
ok(/not the name the board asked for/.test(forced.found.join(' ')),
   '  and records that it was not the expected name', forced.found.join(' | '));

await refuses('with no programmer anywhere, it refuses rather than half-flashing',
  () => fw.planLocalUpdate({ name: 'Duet3Firmware_MB6HC.uf2', bytes: good }, [BOARD], { present: new Set() }),
  /programmer the board copies into RAM/);

await refuses('an SBC machine is refused',
  () => fw.planLocalUpdate({ name: 'Duet3Firmware_MB6HC.uf2', bytes: good }, [{ ...BOARD, sbc: true }], { present: IAP_ON_CARD }),
  /Single Board Computer/);

// --- A zip, the shape Duet3D actually ship ----------------------------------

const archive = zip([
  ['Duet2and3Firmware/Duet3Firmware_MB6HC.uf2', Buffer.from(good)],
  ['Duet2and3Firmware/Duet3_SDiap32_MB6HC.bin', Buffer.alloc(40000, 7)],
  ['Duet2and3Firmware/Duet3Firmware_Mini5plus.uf2', Buffer.from(uf2(32))],
]);
const fromZip = await fw.planLocalUpdate({ name: 'Duet2and3Firmware-3.6.1.zip', bytes: archive }, [BOARD], { present: new Set() });
ok(fromZip.files.has('/firmware/Duet3Firmware_MB6HC.uf2'), 'a zip gives up this board’s image',
   [...fromZip.files.keys()].join(', '));
ok(fromZip.files.has('/firmware/Duet3_SDiap32_MB6HC.bin'),
   '  and its programmer, so no card copy is needed', [...fromZip.files.keys()].join(', '));
ok(!fromZip.files.has('/firmware/Duet3Firmware_Mini5plus.uf2'),
   '  and leaves the other boards’ images alone');

await refuses('a zip without this board’s image is refused, and says what it does hold',
  () => fw.planLocalUpdate({ name: 'other.zip', bytes: zip([['Duet3Firmware_Mini5plus.uf2', Buffer.from(uf2(32))]]) }, [BOARD], { present: IAP_ON_CARD }),
  /contains no Duet3Firmware_MB6HC\.uf2.*It holds/s);

console.log(fails.length ? `\n${fails.length} FAILED: ${fails.join(', ')}` : '\nall passed');
process.exit(fails.length ? 1 : 0);
