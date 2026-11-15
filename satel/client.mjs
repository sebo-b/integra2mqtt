// SATEL INTEGRA integration protocol - TCP client (ETHM-1 / ETHM-1 Plus, or INT-RS via a
// serial-to-TCP bridge). One persistent connection, one request in flight (the spec requires
// waiting for each answer), a timeout per request.

import { connect } from "node:net";
import { encodeFrame, FrameDecoder } from "./frame.mjs";
import { Cmd, RESULT_TEXT } from "./commands.mjs";

export class SatelError extends Error {
  constructor(message, result) {
    super(message);
    this.name = "SatelError";
    this.result = result; // 0xEF result code, if the panel answered with one
  }
}

const hex = (n) => "0x" + n.toString(16).padStart(2, "0").toUpperCase();

export class SatelClient {
  #host;
  #port;
  #timeout;
  #sock = null;
  #pending = null; // done(frame, error) of the request in flight
  #pendingCode = -1;
  #queue = Promise.resolve();

  // timeout: the spec suggests 3 s; commands may override it with cmd.timeout
  constructor({ host, port = 7094, timeout = 3000 }) {
    this.#host = host;
    this.#port = port;
    this.#timeout = timeout;
  }

  get connected() {
    return this.#sock !== null;
  }

  // Run a command from commands.mjs. Connects on demand; requests are serialised.
  exec(cmd) {
    const run = this.#queue.then(() => this.#exec(cmd));
    this.#queue = run.catch(() => {});
    return run;
  }

  close() {
    const sock = this.#sock;
    this.#sock = null;
    sock?.destroy();
    this.#pending?.(null, new Error("connection closed"));
  }

  async #exec(cmd) {
    if (!this.#sock) await this.#connect();
    const frame = await this.#request(cmd.code, encodeFrame(cmd.code, cmd.data ?? []), cmd.timeout ?? this.#timeout);
    if (frame.cmd === Cmd.RESULT) {
      const r = frame.data[0];
      if (!cmd.decode && (r === 0x00 || r === 0xff)) return r;
      throw new SatelError(`${hex(cmd.code)}: ${RESULT_TEXT[r] ?? "error " + hex(r)}`, r);
    }
    return cmd.decode ? cmd.decode(frame.data) : frame.data;
  }

  #connect() {
    return new Promise((resolve, reject) => {
      const sock = connect({ host: this.#host, port: this.#port });
      const decoder = new FrameDecoder();
      const timer = setTimeout(() => {
        sock.destroy();
        reject(new Error(`connect to ${this.#host}:${this.#port} timed out`));
      }, this.#timeout);
      sock.setNoDelay(true);
      sock.once("connect", () => {
        clearTimeout(timer);
        this.#sock = sock;
        resolve();
      });
      sock.on("error", (e) => {
        clearTimeout(timer);
        reject(e); // no-op once connected; 'close' follows
      });
      sock.on("close", () => {
        if (this.#sock === sock) this.close();
      });
      sock.on("data", (chunk) => {
        if (this.#sock !== sock) return;
        for (const f of decoder.push(chunk)) {
          // anything that is not the answer to the pending request is stale/unsolicited: drop it
          if (this.#pending && (f.cmd === this.#pendingCode || f.cmd === Cmd.RESULT)) this.#pending(f);
        }
      });
    });
  }

  #request(code, frame, timeout) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        done(null, new SatelError(`${hex(code)}: no answer within ${timeout} ms`));
        this.close(); // a late answer would be taken for the next request's: start over
      }, timeout);
      const done = (f, err) => {
        clearTimeout(timer);
        this.#pending = null;
        err ? reject(err) : resolve(f);
      };
      this.#pending = done;
      this.#pendingCode = code;
      this.#sock.write(frame);
    });
  }
}
