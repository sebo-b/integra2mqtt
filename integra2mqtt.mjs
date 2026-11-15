// SATEL INTEGRA -> MQTT bridge with Home Assistant discovery. Monitoring only: it never
// sends a control command or a user code to the panel.

import mqtt from "mqtt";
import { setTimeout as sleep } from "node:timers/promises";
import { SatelClient, SatelError } from "./satel/client.mjs";
import * as S from "./satel/commands.mjs";

const { Cmd, DeviceType } = S;

// ---------- config (env; Bun also reads .env)

const env = process.env;
for (const k of ["INTEGRA_HOST", "MQTT_URL"]) if (!env[k]) throw new Error(`${k} is not set (see .env.example)`);
const cfg = {
  host: env.INTEGRA_HOST,
  port: Number(env.INTEGRA_PORT || 7094),
  mqttUrl: env.MQTT_URL,
  topic: env.MQTT_TOPIC || "integra",
  discovery: env.HA_DISCOVERY_PREFIX ?? "homeassistant", // empty = no HA discovery
  pollMs: Number(env.POLL_MS || 1000),
  retryMs: Number(env.RETRY_MS || 10000),
};

const ZONE_FLAGS = {
  [Cmd.ZONES_VIOLATION]: "violation",
  [Cmd.ZONES_TAMPER]: "tamper",
  [Cmd.ZONES_ALARM]: "alarm",
  [Cmd.ZONES_TAMPER_ALARM]: "tamper_alarm",
  [Cmd.ZONES_BYPASS]: "bypass",
  [Cmd.ZONES_NO_VIOLATION_TROUBLE]: "no_violation_trouble",
  [Cmd.ZONES_LONG_VIOLATION_TROUBLE]: "long_violation_trouble",
};
const PARTITION_FLAGS = {
  [Cmd.PARTITIONS_ARMED]: "armed",
  [Cmd.PARTITIONS_ENTRY_TIME]: "entry_time",
  [Cmd.PARTITIONS_EXIT_TIME_LONG]: "exit_time",
  [Cmd.PARTITIONS_EXIT_TIME_SHORT]: "exit_time_short",
  [Cmd.PARTITIONS_ALARM]: "alarm",
  [Cmd.PARTITIONS_FIRE_ALARM]: "fire_alarm",
};

// ---------- state

const satel = new SatelClient({ host: cfg.host, port: cfg.port });
let zones = new Map(); // number -> { name, ...flags }
let partitions = new Map();
const panel = { service_mode: false, troubles: false, troubles_memory: false, trouble_list: [] };
const troubleParts = { [Cmd.TROUBLES_1]: [], [Cmd.TROUBLES_4]: [] };
let wide = false; // 32-byte zone bitmaps (INTEGRA 256 Plus)
let device = {};

// ---------- MQTT

const statusTopic = `${cfg.topic}/status`;
let online = false;
const client = mqtt.connect(cfg.mqttUrl, { will: { topic: statusTopic, payload: "offline", retain: true } });
client.on("connect", () => setOnline(online, true));
client.on("error", (e) => console.error("mqtt:", e.message));

// Publishes are fire-and-forget: mqtt.js queues them while offline, so the panel loop never
// blocks on the broker.
const publish = (topic, payload) =>
  client.publish(topic, typeof payload === "string" ? payload : JSON.stringify(payload), { retain: true });

function setOnline(value, force = false) {
  if (value === online && !force) return;
  online = value;
  publish(statusTopic, value ? "online" : "offline");
}

const n3 = (n) => String(n).padStart(3, "0");
const n2 = (n) => String(n).padStart(2, "0");
const zoneTopic = (n) => `${cfg.topic}/zone/${n3(n)}`;
const partitionTopic = (n) => `${cfg.topic}/partition/${n2(n)}`;
const panelTopic = `${cfg.topic}/panel`;

const publishZone = (n, z) => publish(zoneTopic(n), { zone_number: n, name: z.name, state: z.violation ? "ON" : "OFF", ...flagsOf(z, ZONE_FLAGS) });
const publishPartition = (n, p) =>
  publish(partitionTopic(n), { partition_number: n, name: p.name, state: partitionState(p), ...flagsOf(p, PARTITION_FLAGS) });
const publishPanel = () => publish(panelTopic, { ...panel, ...device });

const flagsOf = (obj, flags) => Object.fromEntries(Object.values(flags).map((f) => [f, !!obj[f]]));

function partitionState(p) {
  if (p.alarm || p.fire_alarm) return "triggered";
  if (p.entry_time) return "pending";
  if (p.exit_time || p.exit_time_short) return "arming";
  return p.armed ? "armed" : "disarmed";
}

// ---------- Home Assistant discovery (retained, so HA restarts need nothing from us)

function discover() {
  if (!cfg.discovery) return;
  const dev = {
    name: "Integra",
    identifiers: ["integra_1F36E156-59DF-4737-9036-C14AD9951AE1"], // kept stable: existing entities stay attached
    manufacturer: "Satel",
    model: device.model,
    sw_version: device.firmware,
  };
  const base = { availability_topic: statusTopic, device: dev };
  const config = (component, id, cfgObj) =>
    publish(`${cfg.discovery}/${component}/integra/${id}/config`, {
      ...base,
      unique_id: id,
      default_entity_id: `${component}.${id}`,
      ...cfgObj,
    });

  for (const [n, z] of zones) {
    config("binary_sensor", `integra_zone_${n3(n)}`, {
      name: z.name || `Zone ${n3(n)}`,
      device_class: "motion",
      state_topic: zoneTopic(n),
      value_template: "{{ value_json.state }}",
      json_attributes_topic: zoneTopic(n),
    });
  }
  for (const [n, p] of partitions) {
    config("sensor", `integra_partition_${n2(n)}`, {
      name: p.name || `Partition ${n2(n)}`,
      device_class: "enum",
      options: ["disarmed", "arming", "pending", "armed", "triggered"],
      icon: "mdi:shield-home",
      state_topic: partitionTopic(n),
      value_template: "{{ value_json.state }}",
      json_attributes_topic: partitionTopic(n),
    });
  }
  const diag = (id, name, key, extra = {}) =>
    config("binary_sensor", `integra_${id}`, {
      name,
      entity_category: "diagnostic",
      state_topic: panelTopic,
      value_template: `{{ 'ON' if value_json.${key} else 'OFF' }}`,
      json_attributes_topic: panelTopic,
      ...extra,
    });
  diag("service_mode", "Service mode", "service_mode", { icon: "mdi:wrench" });
  diag("troubles", "Troubles", "troubles", { device_class: "problem" });
  diag("troubles_memory", "Troubles memory", "troubles_memory", { device_class: "problem" });
}

// ---------- panel

// Numbers 1..max whose name can be read. Unused/placeholder ones answer 0xEF 'other error'.
async function readNames(type, max) {
  const found = new Map();
  for (let n = 1; n <= max; n++) {
    try {
      found.set(n, { name: (await satel.exec(S.readDeviceName(type, n))).name });
    } catch (e) {
      if (!(e instanceof SatelError && e.result !== undefined)) throw e; // timeouts etc. are real errors
    }
  }
  return found;
}

async function refresh(code) {
  if (code in ZONE_FLAGS || code in PARTITION_FLAGS) {
    const [items, field, pub] = code in ZONE_FLAGS ? [zones, ZONE_FLAGS[code], publishZone] : [partitions, PARTITION_FLAGS[code], publishPartition];
    const active = new Set(await satel.exec(S.readState(code, wide)));
    for (const [n, item] of items) {
      if (!!item[field] === active.has(n)) continue;
      item[field] = active.has(n);
      pub(n, item);
    }
    return;
  }
  const before = JSON.stringify(panel);
  if (code === Cmd.RTC_AND_STATUS) {
    const s = await satel.exec(S.readRtcAndStatus());
    Object.assign(panel, { service_mode: s.serviceMode, troubles: s.troubles, troubles_memory: s.troublesMemory });
  } else {
    troubleParts[code] = await satel.exec(code === Cmd.TROUBLES_1 ? S.readTroubles1() : S.readTroubles4());
    panel.trouble_list = Object.values(troubleParts).flat();
  }
  if (JSON.stringify(panel) !== before) publishPanel();
}

const TRACKED = [
  ...Object.keys(ZONE_FLAGS).map(Number),
  ...Object.keys(PARTITION_FLAGS).map(Number),
  Cmd.RTC_AND_STATUS,
  Cmd.TROUBLES_1,
  Cmd.TROUBLES_4,
];

async function session() {
  const integra = await satel.exec(S.readIntegraVersion());
  const module = await satel.exec(S.readModuleVersion());
  wide = integra.zones > 128 && module.wide;
  device = { model: integra.model, firmware: integra.version, module_firmware: module.version };
  console.log(`connected: ${integra.model} ${integra.version}, module ${module.version}`);

  zones = await readNames(DeviceType.ZONE, integra.zones);
  partitions = await readNames(DeviceType.PARTITION, 32);
  console.log(`${zones.size} zones, ${partitions.size} partitions`);
  discover();

  // full read once (publishes everything), then only what the panel reports as changed
  for (const code of TRACKED) await refresh(code);
  for (const [n, z] of zones) publishZone(n, z);
  for (const [n, p] of partitions) publishPartition(n, p);
  publishPanel();
  setOnline(true);

  for (;;) {
    await sleep(cfg.pollMs);
    const changed = await satel.exec(S.readNewData());
    for (const code of TRACKED) if (changed.has(code)) await refresh(code);
  }
}

// Every failure (network, DNS, timeout, bug) ends the session; we go offline and reconnect.
for (;;) {
  try {
    await session();
  } catch (e) {
    console.error(new Date().toISOString(), "panel:", e.message);
  }
  setOnline(false);
  satel.close();
  await sleep(cfg.retryMs);
}
