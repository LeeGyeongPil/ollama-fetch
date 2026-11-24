// AC-1: GGUF 리더·라이터 왕복이 바이트 단위로 같고, GGUF 가 아니면 GgufFormatError
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { GgufFormatError, InputError } from '../../src/errors.js';
import { buildHeader, getKv, type GgufArray, GgufType, readGguf, tensorNbytes } from '../../src/gguf.js';
import { encodeGguf, encodeModel, synthModel } from '../../src/mock/synth-gguf.js';
import { cleanupTempDirs, sha256Hex, tempDir } from '../support/helpers.js';

after(cleanupTempDirs);

/** 읽은 헤더로 헤더 바이트를 다시 만들고, 원래 데이터 영역을 붙인다 */
async function roundTrip(bytes: Buffer): Promise<Buffer> {
  const dir = await tempDir();
  const path = join(dir, 'model.gguf');
  await writeFile(path, bytes);
  const header = readGguf(path);
  return Buffer.concat([buildHeader(header), bytes.subarray(header.dataOffset)]);
}

describe('AC-1 GGUF reader/writer', () => {
  for (const alignment of [32, 64]) {
    it(`round-trips a synthetic model byte-for-byte (alignment ${alignment})`, async () => {
      const original = encodeModel(synthModel({ alignment }));
      const again = await roundTrip(original);
      assert.equal(sha256Hex(again), sha256Hex(original));
      assert.ok(again.equals(original));
    });
  }

  it('reads every KV type with the right value', async () => {
    const dir = await tempDir();
    const path = join(dir, 'm.gguf');
    await writeFile(path, encodeModel(synthModel({ alignment: 64 })));
    const h = readGguf(path);
    assert.equal(h.version, 3);
    assert.equal(h.alignment, 64);
    assert.equal(h.dataOffset % 64, 0);
    assert.equal(getKv(h, 'general.architecture'), 'llama');
    assert.equal(getKv(h, 'synth.u8'), 200);
    assert.equal(getKv(h, 'synth.i8'), -7);
    assert.equal(getKv(h, 'synth.u16'), 65000);
    assert.equal(getKv(h, 'synth.i16'), -1234);
    assert.equal(getKv(h, 'synth.i32'), -123456);
    assert.equal(getKv(h, 'synth.bool'), true);
    assert.equal(getKv(h, 'synth.u64'), 1n << 40n);
    assert.equal(getKv(h, 'synth.i64'), -(1n << 40n));
    assert.equal(getKv(h, 'synth.f64'), 3.141592653589793);
    assert.equal(getKv(h, 'llama.rope.freq_base'), 10000);
    const tokens = getKv(h, 'tokenizer.ggml.tokens') as GgufArray;
    assert.equal(tokens.itemType, GgufType.STRING);
    assert.deepEqual(tokens.items.slice(0, 3), ['<unk>', '<s>', '</s>']);
    const nested = getKv(h, 'synth.nested') as GgufArray;
    assert.deepEqual((nested.items[1] as GgufArray).items, ['한국어', 'emoji ✓']);
    assert.equal(h.tensors.length, 22);
    for (const t of h.tensors) assert.equal(Number(t.offset) % 64, 0, `${t.name} offset aligned`);
    assert.equal(tensorNbytes(h.tensors.find((t) => t.name === 'rope_freqs.weight')!), 36);
  });

  it('parses a hand-written GGUF (independent of our writer)', async () => {
    // "GGUF", v3, 텐서 1개, KV 2개(general.alignment=64, general.name="x"), 텐서 w: [4] F32 offset 0
    const parts: Buffer[] = [];
    const u32 = (v: number) => { const b = Buffer.alloc(4); b.writeUInt32LE(v); parts.push(b); };
    const u64 = (v: number) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(v)); parts.push(b); };
    const str = (s: string) => { u64(Buffer.byteLength(s)); parts.push(Buffer.from(s)); };
    parts.push(Buffer.from('GGUF'));
    u32(3);
    u64(1);
    u64(2);
    str('general.alignment'); u32(4); u32(64);
    str('general.name'); u32(8); str('x');
    str('w'); u32(1); u64(4); u32(0); u64(0);
    const head = Buffer.concat(parts);
    const padded = Math.ceil(head.length / 64) * 64;
    const data = Buffer.alloc(16);
    [1.5, -2, 0.25, 8].forEach((f, i) => data.writeFloatLE(f, i * 4));
    const file = Buffer.concat([head, Buffer.alloc(padded - head.length), data]);

    const dir = await tempDir();
    const path = join(dir, 'hand.gguf');
    await writeFile(path, file);
    const h = readGguf(path);
    assert.equal(h.headerSize, head.length);
    assert.equal(h.dataOffset, padded);
    assert.equal(h.alignment, 64);
    assert.equal(getKv(h, 'general.name'), 'x');
    assert.deepEqual(h.tensors, [{ name: 'w', dims: [4n], ggmlType: 0, offset: 0n }]);
    assert.ok(buildHeader(h).equals(file.subarray(0, padded)));
  });

  it('keeps non-UTF-8 string bytes exactly', async () => {
    const kv = [{ key: 'raw', type: GgufType.STRING, value: Buffer.from([0xff, 0xfe, 0x41]) }];
    const original = encodeGguf(kv, [{ name: 't', dims: [8], data: Buffer.alloc(32, 1) }], 32);
    const again = await roundTrip(original);
    assert.ok(again.equals(original));
  });

  it('rejects non-GGUF, truncated and v1 files with GgufFormatError', async () => {
    const dir = await tempDir();
    const notGguf = join(dir, 'notes.txt');
    await writeFile(notGguf, 'hello, this is definitely not a model file');
    assert.throws(() => readGguf(notGguf), GgufFormatError);
    assert.throws(() => readGguf(notGguf), InputError); // 종료 코드 2 계열

    const full = encodeModel(synthModel());
    const truncated = join(dir, 'cut.gguf');
    await writeFile(truncated, full.subarray(0, 200));
    assert.throws(() => readGguf(truncated), GgufFormatError);

    const v1 = Buffer.from(full);
    v1.writeUInt32LE(1, 4);
    const v1Path = join(dir, 'v1.gguf');
    await writeFile(v1Path, v1);
    assert.throws(() => readGguf(v1Path), GgufFormatError);

    assert.throws(() => readGguf(join(dir, 'missing.gguf')), GgufFormatError);
  });
});
