// SATEL INTEGRA integration protocol (INT-RS / ETHM-1) - framing only.
// Spec: "INT-RS v1.19 / INT-RS Plus v2.21 / ETHM-1 Plus" protocol description, SATEL 2025-09-26.
//
//   FE FE | cmd d1 .. dn | crc.hi crc.lo | FE 0D
//
// Any 0xFE inside cmd..crc is sent as FE F0; the crc covers the unescaped bytes.

export function crc(bytes) {
  let c = 0x147a;
  for (const b of bytes) {
    c = ((c << 1) | (c >> 15)) & 0xffff; // rotate left
    c ^= 0xffff;
    c = (c + (c >> 8) + b) & 0xffff;
  }
  return c;
}

export function encodeFrame(cmd, data = []) {
  const body = [cmd, ...data];
  const sum = crc(body);
  const out = [0xfe, 0xfe];
  for (const b of [...body, sum >> 8, sum & 0xff]) {
    out.push(b);
    if (b === 0xfe) out.push(0xf0);
  }
  out.push(0xfe, 0x0d);
  return Buffer.from(out);
}

// Streaming decoder: feed raw socket chunks, get back complete frames with a valid crc.
// Corrupted frames are dropped silently, as the spec requires.
export class FrameDecoder {
  #buf = null; // null = not synchronised yet
  #esc = false; // previous byte was 0xFE

  push(chunk) {
    const frames = [];
    for (const b of chunk) {
      if (this.#esc) {
        this.#esc = false;
        if (b === 0xf0) this.#buf?.push(0xfe);
        else if (b === 0x0d) {
          const f = this.#buf && check(this.#buf);
          if (f) frames.push(f);
          this.#buf = null;
        } else this.#buf = []; // FE FE or FE <other>: (re)synchronise, wait for cmd
      } else if (b === 0xfe) {
        if (this.#buf?.length !== 0) this.#esc = true; // FE while waiting for cmd is ignored
      } else this.#buf?.push(b);
    }
    return frames;
  }
}

function check(buf) {
  if (buf.length < 3) return null;
  const n = buf.length - 2;
  if (crc(buf.slice(0, n)) !== ((buf[n] << 8) | buf[n + 1])) return null;
  return { cmd: buf[0], data: Buffer.from(buf.slice(1, n)) };
}
