# integra2mqtt

Publishes the state of a SATEL INTEGRA alarm panel to MQTT, with Home Assistant discovery.
It talks to the panel's integration protocol over an ETHM-1 / ETHM-1 Plus module (or INT-RS
behind a serial-to-TCP bridge). **Monitoring only:** it never sends a control command or a
user code to the panel.

No dependencies besides `mqtt`. Runs on [Bun](https://bun.sh).

## Setup

1. On the panel, enable the integration protocol on the ETHM module (DLOADX: ETHM-1 →
   Integration, default port 7094), unencrypted. The module accepts one client at a time.
2. ```sh
   bun install
   cp .env.example .env   # set INTEGRA_HOST and MQTT_URL
   bun start
   ```

| Variable              | Default         | Meaning                                    |
| --------------------- | --------------- | ------------------------------------------ |
| `INTEGRA_HOST`        | (required)      | ETHM module address                        |
| `INTEGRA_PORT`        | `7094`          | integration port                           |
| `MQTT_URL`            | (required)      | e.g. `mqtt://user:pass@broker:1883`        |
| `MQTT_TOPIC`          | `integra`       | topic prefix                               |
| `HA_DISCOVERY_PREFIX` | `homeassistant` | empty disables discovery                   |
| `POLL_MS`             | `1000`          | how often to ask the panel what changed    |
| `RETRY_MS`            | `10000`         | wait before reconnecting after any failure |

## What it publishes

Zones and partitions are discovered from the panel: every number whose name can be read is
published. Placeholder zones (no detector) are skipped. All topics are retained.

| Topic                    | Payload                                                                                                       | HA entity                                    |
| ------------------------ | ------------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| `integra/status`         | `online` / `offline` (also the MQTT last will)                                                                | availability of all entities                 |
| `integra/zone/NNN`       | `{zone_number, name, state: ON/OFF, violation, tamper, alarm, tamper_alarm, bypass, no_violation_trouble, long_violation_trouble}` | `binary_sensor.integra_zone_NNN` (motion)    |
| `integra/partition/NN`   | `{partition_number, name, state, armed, entry_time, exit_time, exit_time_short, alarm, fire_alarm}`; `state` is `disarmed` / `arming` / `pending` / `armed` / `triggered` | `sensor.integra_partition_NN`                |
| `integra/panel`          | `{service_mode, troubles, troubles_memory, trouble_list, model, firmware, module_firmware}`                     | `binary_sensor.integra_service_mode`, `binary_sensor.integra_troubles`, `binary_sensor.integra_troubles_memory` (diagnostic) |

Zone and partition names are read once at startup (about 200 requests, ~40 s on an ETHM-1
Plus), not on reconnects. Commands on `integra/cmd`:

| Payload            | Effect                                             |
| ------------------ | -------------------------------------------------- |
| `refresh_names`    | re-read names, republish discovery and all states  |
| `run_ha_discovery` | republish discovery                                |
| `read_zone_states` | re-read and republish all states                   |

`trouble_list` decodes trouble parts 1 and 4: system troubles (AC, BATT, outputs, RTC, ...),
technical zones, and expanders/keypads with AC/battery/communication/tamper problems.

The bridge polls command `0x7F` ("which data changed") and reads only what changed. Any
failure (network, timeout, unexpected answer) marks it `offline`, drops the connection and
reconnects after `RETRY_MS`; it never hangs silently.

## Layout

```
satel/frame.mjs      CRC, framing, streaming frame decoder (pure)
satel/commands.mjs   command codes, request builders, answer decoders (pure)
satel/client.mjs     TCP client: one connection, one request in flight, timeouts
integra2mqtt.mjs     the bridge: panel state -> MQTT / Home Assistant
test/                bun test
```

The `satel/` directory knows nothing about MQTT and can be reused on its own:

```js
import { SatelClient } from "./satel/client.mjs";
import * as S from "./satel/commands.mjs";

const panel = new SatelClient({ host: "192.168.1.100" });
console.log(await panel.exec(S.readIntegraVersion()));
console.log(await panel.exec(S.readState(S.Cmd.ZONES_VIOLATION))); // [3, 14, ...]
```

### Adding a command

A command is `{ code, data, decode }`. Add a builder to `satel/commands.mjs`:

- **read** commands have `decode(data)`. An `0xEF` answer then rejects with a `SatelError`
  carrying the result code.
- **control** commands (arm/disarm `0x80..0x85`, outputs `0x88..0x89`, ...) have no `decode`.
  `exec()` resolves with the `0xEF` result code when it is `0x00` (OK) or `0xFF` (accepted) and
  rejects otherwise. Their data is the 8-byte user code followed by a partition/output bitmap.
- per-command `timeout` overrides the default 3 s (e.g. `0x7D` zone temperature may take 5 s).

Protocol reference: SATEL "INT-RS / ETHM-1 integration protocol" description (2025-09-26).
