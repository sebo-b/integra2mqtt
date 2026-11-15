// SATEL INTEGRA integration protocol - commands and answer decoders (no I/O).
//
// A command is a plain object { code, data, decode?, timeout? } handed to SatelClient.exec():
//   - decode(data) turns the answer payload into a value; an 0xEF answer is then an error.
//   - no decode: the command expects only an 0xEF result (control commands); 0x00/0xFF resolve.
// Adding a command = adding a builder here. Control commands (0x80.. arm/disarm, 0x88 outputs)
// would be builders without decode, sending the 8-byte user code + a partition/output bitmap;
// event log reading (0x8C) is a builder with a decoder.

export const Cmd = Object.freeze({
  // Part 1 - state bitmaps: zones/outputs 16 bytes (32 with `wide`), partitions 4, doors 8
  ZONES_VIOLATION: 0x00,
  ZONES_TAMPER: 0x01,
  ZONES_ALARM: 0x02,
  ZONES_TAMPER_ALARM: 0x03,
  ZONES_ALARM_MEMORY: 0x04,
  ZONES_TAMPER_ALARM_MEMORY: 0x05,
  ZONES_BYPASS: 0x06,
  ZONES_NO_VIOLATION_TROUBLE: 0x07,
  ZONES_LONG_VIOLATION_TROUBLE: 0x08,
  PARTITIONS_ARMED_SUPPRESSED: 0x09,
  PARTITIONS_ARMED: 0x0a,
  PARTITIONS_ARMED_MODE_2: 0x0b,
  PARTITIONS_ARMED_MODE_3: 0x0c,
  PARTITIONS_FIRST_CODE_ENTERED: 0x0d,
  PARTITIONS_ENTRY_TIME: 0x0e,
  PARTITIONS_EXIT_TIME_LONG: 0x0f,
  PARTITIONS_EXIT_TIME_SHORT: 0x10,
  PARTITIONS_TEMPORARY_BLOCKED: 0x11,
  PARTITIONS_GUARD_ROUND_BLOCKED: 0x12,
  PARTITIONS_ALARM: 0x13,
  PARTITIONS_FIRE_ALARM: 0x14,
  PARTITIONS_ALARM_MEMORY: 0x15,
  PARTITIONS_FIRE_ALARM_MEMORY: 0x16,
  OUTPUTS_STATE: 0x17,
  DOORS_OPENED: 0x18,
  DOORS_OPENED_LONG: 0x19,
  RTC_AND_STATUS: 0x1a,
  TROUBLES_1: 0x1b,
  TROUBLES_2: 0x1c,
  TROUBLES_3: 0x1d,
  TROUBLES_4: 0x1e,
  TROUBLES_5: 0x1f,
  TROUBLES_MEMORY_1: 0x20,
  TROUBLES_MEMORY_2: 0x21,
  TROUBLES_MEMORY_3: 0x22,
  TROUBLES_MEMORY_4: 0x23,
  TROUBLES_MEMORY_5: 0x24,
  PARTITIONS_VIOLATED_ZONES: 0x25,
  ZONES_ISOLATE: 0x26,
  PARTITIONS_VERIFIED_ALARMS: 0x27,
  ZONES_MASKED: 0x28,
  ZONES_MASKED_MEMORY: 0x29,
  PARTITIONS_ARMED_MODE_1: 0x2a,
  PARTITIONS_WARNING_ALARMS: 0x2b,
  // versions / change list
  MODULE_VERSION: 0x7c,
  INTEGRA_VERSION: 0x7e,
  NEW_DATA: 0x7f,
  // Part 2/3 (not implemented yet): 0x80..0x91 control, 0x8C read event, 0xE0.. users
  READ_EVENT: 0x8c,
  READ_DEVICE_NAME: 0xee,
  RESULT: 0xef,
});

export const DeviceType = Object.freeze({ PARTITION: 0, ZONE: 1, USER: 2, EXPANDER_LCD: 3, OUTPUT: 4 });

export const RESULT_TEXT = Object.freeze({
  0x00: "OK",
  0x01: "requesting user code not found",
  0x02: "no access",
  0x03: "selected user does not exist",
  0x04: "selected user already exists",
  0x05: "wrong code or code already exists",
  0x06: "telephone code already exists",
  0x07: "changed code is the same",
  0x08: "other error",
  0x11: "can not arm, but can use force arm",
  0x12: "can not arm",
  0xff: "command accepted",
});

// INTEGRA type byte from 0x7E -> model and number of zones
export const MODELS = Object.freeze({
  0: ["INTEGRA 24", 24],
  1: ["INTEGRA 32", 32],
  2: ["INTEGRA 64", 64],
  3: ["INTEGRA 128", 128],
  4: ["INTEGRA 128-WRL SIM300", 128],
  132: ["INTEGRA 128-WRL LEON", 128],
  66: ["INTEGRA 64 Plus", 64],
  67: ["INTEGRA 128 Plus", 128],
  72: ["INTEGRA 256 Plus", 256],
});

// ---------- helpers

// Set bits -> list of numbers, LSB of byte 0 first. Zones/outputs/partitions start at 1,
// expanders/keypads at address 0 (base = 0).
export function fromBitmap(data, base = 1) {
  const out = [];
  data.forEach((byte, i) => {
    for (let bit = 0; bit < 8; bit++) if (byte & (1 << bit)) out.push(i * 8 + bit + base);
  });
  return out;
}

// '12320120527' -> '1.23 2012-05-27'
const version = (b) => {
  const s = String.fromCharCode(...b);
  return `${s[0]}.${s.slice(1, 3)} ${s.slice(3, 7)}-${s.slice(7, 9)}-${s.slice(9, 11)}`;
};

const bcd = (b) => (b >> 4) * 10 + (b & 0x0f);
const pad = (n) => String(n).padStart(2, "0");

// shortcut: cp1250 only (Polish/Central-European panels); Bun's TextDecoder lacks it.
// Make the code page a parameter when a panel in another language shows up.
const CP1250_HIGH =
  "€�‚�„…†‡�‰Š‹ŚŤŽŹ" +
  "�‘’“”•–—�™š›śťžź" +
  "\xa0ˇ˘Ł\xa4Ą\xa6\xa7\xa8\xa9Ş\xab\xac\xad\xaeŻ" +
  "\xb0\xb1˛ł\xb4\xb5\xb6\xb7\xb8ąş\xbbĽ˝ľż" +
  "Ŕ\xc1\xc2Ă\xc4ĹĆ\xc7Č\xc9Ę\xcbĚ\xcd\xceĎ" +
  "ĐŃŇ\xd3\xd4Ő\xd6\xd7ŘŮ\xdaŰ\xdc\xddŢ\xdf" +
  "ŕ\xe1\xe2ă\xe4ĺć\xe7č\xe9ę\xebě\xed\xeeď" +
  "đńň\xf3\xf4ő\xf6\xf7řů\xfaű\xfc\xfdţ˙";

export const decodeText = (bytes) =>
  Array.from(bytes, (b) => (b < 0x80 ? String.fromCharCode(b) : CP1250_HIGH[b - 0x80])).join("").trim();

// ---------- read commands

// Any Part 1 state bitmap (0x00..0x2B). `wide` asks for 256 zones/outputs (INT-RS Plus /
// ETHM-1 Plus with INTEGRA 256 Plus); it is ignored by commands without 16/32-byte answers.
export const readState = (code, wide = false) => ({ code, data: wide ? [0] : [], decode: (d) => fromBitmap(d) });

// Which Part 1 commands have new data since they were last read -> Set of command codes.
// The 5-byte form covers 0x00..0x27 and works on every module.
export const readNewData = () => ({ code: Cmd.NEW_DATA, data: [], decode: (d) => new Set(fromBitmap(d, 0)) });

export const readIntegraVersion = () => ({
  code: Cmd.INTEGRA_VERSION,
  data: [],
  decode: (d) => ({
    type: d[0],
    model: MODELS[d[0]]?.[0] ?? `INTEGRA (type ${d[0]})`,
    zones: MODELS[d[0]]?.[1] ?? 128,
    version: version(d.subarray(1, 12)),
    language: d[12],
    settingsInFlash: d[13] === 0xff,
  }),
});

export const readModuleVersion = () => ({
  code: Cmd.MODULE_VERSION,
  data: [],
  decode: (d) => ({
    version: version(d.subarray(0, 11)),
    wide: !!(d[11] & 0x01), // can serve 32-byte zone/output bitmaps
    troublesPart8: !!(d[11] & 0x02),
    armNoBypass: !!(d[11] & 0x04),
  }),
});

export const readRtcAndStatus = () => ({
  code: Cmd.RTC_AND_STATUS,
  data: [],
  decode: (d) => ({
    // panel local time, as 'YYYY-MM-DD hh:mm:ss'
    time: `${pad(bcd(d[0]))}${pad(bcd(d[1]))}-${pad(bcd(d[2]))}-${pad(bcd(d[3]))} ${pad(bcd(d[4]))}:${pad(bcd(d[5]))}:${pad(bcd(d[6]))}`,
    dayOfWeek: d[7] & 0x07, // 0 = Monday
    serviceMode: !!(d[7] & 0x80),
    troubles: !!(d[7] & 0x40),
    acu100Present: !!(d[8] & 0x80),
    intRxPresent: !!(d[8] & 0x40),
    troublesMemory: !!(d[8] & 0x20),
    grade23: !!(d[8] & 0x10),
    integraType: d[8] & 0x0f,
  }),
});

// 0xEE. Placeholder ('no detector') zones and unused numbers answer 0xEF 'other error'.
export const readDeviceName = (type, number) => ({
  code: Cmd.READ_DEVICE_NAME,
  data: [type, number & 0xff], // 256 is sent as 0
  decode: (d) => ({ type: d[0], number: d[1] || 256, function: d[2], name: decodeText(d.subarray(3, 19)) }),
});

// ---------- troubles -> list of human-readable strings

const SYSTEM_TROUBLES = [
  ["OUT1", "OUT2", "OUT3", "OUT4", "+KPD", "+EX1/+EX2", "BATT", "AC"],
  ["DT1", "DT2", "DTM", "RTC", "no DTR signal", "no BATT present", "external modem init", "external modem command"],
  [
    "no voltage on telephone line",
    "bad signal on telephone line",
    "no signal on telephone line",
    "monitoring to station 1",
    "monitoring to station 2",
    "EEPROM or RTC access",
    "RAM memory",
    "main panel restart memory",
  ],
];

const COMMUNICATION_TROUBLES = [
  "no ETHM connection to monitoring station 1",
  "no ETHM connection to monitoring station 2",
  "no GPRS connection to monitoring station 1",
  "no GPRS connection to monitoring station 2",
  "time server",
  "GSM init error",
  "monitoring to IP station 1",
  "monitoring to IP station 2",
];

const named = (byte, names) => names.filter((_, bit) => byte & (1 << bit));
const each = (data, base, label) => fromBitmap(data, base).map(label);

// 0x1B troubles part 1 (47 bytes). Expander bytes have type-dependent meanings; the generic one is used.
export const readTroubles1 = () => ({
  code: Cmd.TROUBLES_1,
  data: [],
  decode: (d) => [
    ...each(d.subarray(0, 16), 1, (n) => `zone ${n}: technical zone trouble`),
    ...each(d.subarray(16, 24), 0, (n) => `expander ${n}: AC`),
    ...each(d.subarray(24, 32), 0, (n) => `expander ${n}: BATT or output overload`),
    ...each(d.subarray(32, 40), 0, (n) => `expander ${n}: no BATT`),
    ...SYSTEM_TROUBLES.flatMap((names, i) => named(d[40 + i], names)),
    ...each(d.subarray(43, 44), 0, (n) => `module ${n}: ETHM-1 ping / PTSA AC`),
    ...each(d.subarray(44, 45), 0, (n) => `module ${n}: SATEL server MAC/ID error / BATT`),
    ...each(d.subarray(45, 46), 0, (n) => `module ${n}: no connection to SATEL server / no BATT`),
    ...named(d[46], COMMUNICATION_TROUBLES),
  ],
});

// 0x1E troubles part 4 (30 bytes): communication and tamper of bus devices.
export const readTroubles4 = () => ({
  code: Cmd.TROUBLES_4,
  data: [],
  decode: (d) => [
    ...each(d.subarray(0, 8), 0, (n) => `expander ${n}: no communication`),
    ...each(d.subarray(8, 16), 0, (n) => `expander ${n}: substituted`),
    ...each(d.subarray(16, 17), 0, (n) => `keypad ${n}: no communication`),
    ...each(d.subarray(17, 18), 0, (n) => `keypad ${n}: substituted`),
    ...each(d.subarray(18, 19), 0, (n) => `module ${n}: no LAN cable / no DSR`),
    ...each(d.subarray(19, 27), 0, (n) => `expander ${n}: tamper`),
    ...each(d.subarray(27, 28), 0, (n) => `keypad ${n}: tamper`),
    ...each(d.subarray(28, 29), 0, (n) => `keypad ${n}: initiation error`),
    ...(d[29] ? ["auxiliary STM trouble"] : []),
  ],
});
