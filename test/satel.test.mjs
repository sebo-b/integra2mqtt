import { test, expect } from "bun:test";
import { createServer } from "node:net";
import { crc, encodeFrame, FrameDecoder } from "../satel/frame.mjs";
import * as S from "../satel/commands.mjs";
import { SatelClient, SatelError } from "../satel/client.mjs";

const hex = (s) => Buffer.from(s.replace(/\s/g, ""), "hex");

// ---------- frame: vectors from the SATEL spec

test("crc: Appendix 4 example", () => {
  expect(crc([0xe0, 0x12, 0x34, 0xff, 0xff])).toBe(0x8a9b);
});

test("encodeFrame: spec example frames, incl. FE escaping", () => {
  expect(encodeFrame(0xe0, [0x12, 0x34, 0xff, 0xff])).toEqual(hex("FE FE E0 12 34 FF FF 8A 9B FE 0D"));
  expect(encodeFrame(0x09)).toEqual(hex("FE FE 09 D7 EB FE 0D"));
  expect(encodeFrame(0x1c)).toEqual(hex("FE FE 1C D7 FE F0 FE 0D"));
});

test("FrameDecoder: byte-by-byte, escapes, garbage, bad crc, resync", () => {
  const d = new FrameDecoder();
  const good = encodeFrame(0x1c); // contains FE F0
  const bad = Buffer.from(encodeFrame(0x09));
  bad[3] ^= 1; // corrupt crc
  const cut = encodeFrame(0x00, [1, 2, 3]).subarray(0, 5); // interrupted by the next FE FE
  const stream = Buffer.concat([hex("00 13 FE"), good, bad, cut, encodeFrame(0x7f, [0xfe, 0x01])]);

  const frames = [...stream].flatMap((b) => d.push([b]));
  expect(frames).toEqual([
    { cmd: 0x1c, data: Buffer.alloc(0) },
    { cmd: 0x7f, data: Buffer.from([0xfe, 0x01]) },
  ]);
});

// ---------- commands

test("readState: spec bitmap example -> zones 3, 14, 128", () => {
  expect(S.readState(0x00).decode(hex("04 20 00 00 00 00 00 00 00 00 00 00 00 00 00 80"))).toEqual([3, 14, 128]);
  expect(S.readState(0x00, true).data).toEqual([0]);
});

test("readNewData: bit n = command n", () => {
  expect([...S.readNewData().decode(hex("01 00 00 0C 00"))]).toEqual([0x00, 0x1a, 0x1b]);
});

test("readIntegraVersion / readModuleVersion", () => {
  const v = S.readIntegraVersion().decode(Buffer.concat([Buffer.from([67]), Buffer.from("11820180620"), Buffer.from([0, 0xff])]));
  expect(v).toEqual({ type: 67, model: "INTEGRA 128 Plus", zones: 128, version: "1.18 2018-06-20", language: 0, settingsInFlash: true });
  const m = S.readModuleVersion().decode(Buffer.concat([Buffer.from("31320250321"), Buffer.from([0x05])]));
  expect(m).toEqual({ version: "3.13 2025-03-21", wide: true, troublesPart8: false, armNoBypass: true });
});

test("readRtcAndStatus", () => {
  const s = S.readRtcAndStatus().decode(hex("20 26 11 15 21 44 15 C6 23"));
  expect(s).toMatchObject({ time: "2026-11-15 21:44:15", dayOfWeek: 6, serviceMode: true, troubles: true, troublesMemory: true, integraType: 3 });
});

test("readDeviceName: cp1250 name, 256 sent as 0", () => {
  const name = Buffer.alloc(16, 0x20);
  Buffer.from([0x50, 0x6f, 0xbf, 0x61, 0x72, 0x20, 0xb3, 0xb9, 0x9c]).copy(name); // "Pożar łąś"
  expect(S.readDeviceName(1, 7).decode(Buffer.concat([Buffer.from([1, 7, 3]), name]))).toEqual({ type: 1, number: 7, function: 3, name: "Pożar łąś" });
  expect(S.readDeviceName(1, 256).data).toEqual([1, 0]);
});

test("troubles part 1 and 4 -> readable list", () => {
  const t1 = Buffer.alloc(47);
  t1[0] = 0x02; // zone 2 technical
  t1[16] = 0x01; // expander 0 AC
  t1[40] = 0x80; // AC
  t1[42] = 0x80; // restart memory
  t1[46] = 0x10; // time server
  expect(S.readTroubles1().decode(t1)).toEqual([
    "zone 2: technical zone trouble",
    "expander 0: AC",
    "AC",
    "main panel restart memory",
    "time server",
  ]);
  const t4 = Buffer.alloc(30);
  t4[0] = 0x08; // expander 3 no communication
  t4[27] = 0x01; // keypad 0 tamper
  expect(S.readTroubles4().decode(t4)).toEqual(["expander 3: no communication", "keypad 0: tamper"]);
});

// ---------- client against a fake panel

function fakePanel(answer) {
  const server = createServer((sock) => {
    const d = new FrameDecoder();
    sock.on("data", (chunk) => {
      for (const f of d.push(chunk)) {
        const a = answer(f);
        if (a) sock.write(encodeFrame(...a));
      }
    });
  });
  return new Promise((r) => server.listen(0, "127.0.0.1", () => r(server)));
}

test("client: serialised requests, 0xEF errors, timeout and reconnect", async () => {
  let silent = true;
  const server = await fakePanel((f) => {
    if (f.cmd === 0x00) return [0x00, [...hex("04 20 00 00 00 00 00 00 00 00 00 00 00 00 00 80")]];
    if (f.cmd === 0xee) return f.data[1] === 1 ? [0xee, [1, 1, 0, ...Buffer.from("Hall            ")]] : [0xef, [0x08]];
    if (f.cmd === 0x7f && silent) return null; // no answer -> timeout
    if (f.cmd === 0x7f) return [0x7f, [1, 0, 0, 0, 0]];
  });
  const c = new SatelClient({ host: "127.0.0.1", port: server.address().port, timeout: 200 });
  try {
    // issued together, answered in order
    const [zones, name] = await Promise.all([c.exec(S.readState(0x00)), c.exec(S.readDeviceName(1, 1))]);
    expect(zones).toEqual([3, 14, 128]);
    expect(name.name).toBe("Hall");

    const err = await c.exec(S.readDeviceName(1, 2)).catch((e) => e);
    expect(err).toBeInstanceOf(SatelError);
    expect(err.result).toBe(0x08);

    const timeout = await c.exec(S.readNewData()).catch((e) => e);
    expect(timeout.message).toContain("no answer");
    expect(c.connected).toBe(false);

    silent = false; // next request reconnects
    expect([...(await c.exec(S.readNewData()))]).toEqual([0]);
  } finally {
    c.close();
    server.close();
  }
});

test("client: control-style command resolves on 0xEF accepted", async () => {
  const server = await fakePanel(() => [0xef, [0xff]]);
  const c = new SatelClient({ host: "127.0.0.1", port: server.address().port, timeout: 200 });
  try {
    expect(await c.exec({ code: 0x84, data: [] })).toBe(0xff);
  } finally {
    c.close();
    server.close();
  }
});
